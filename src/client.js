'use strict';

/**
 * GLaDOS / Railgun 共用的 API 客户端。
 *
 * 两个站点协议完全一致，只有域名不同，所以共用这一份实现。
 *
 * 零依赖：直接用 Node 内置的 fetch（Node 18+），青龙面板无需安装任何依赖。
 * 关键约束：
 *   - 签到 token 恒等于【当前请求的域名】。站点前端发的就是
 *     axios.post('/user/checkin', {token: location.hostname})，
 *     所以 token 按实际域名推导，域名回退时会跟着变。
 *   - 必须带 User-Agent，否则服务端无法解析设备，返回 code=4 device-mismatch
 *   - 兑换接口要求表单提交，发 JSON 会被拒
 */

const { EXCHANGE_PLANS } = require('./config');

/**
 * 服务端返回码语义。
 *
 * 0/1/2/3 取自 railgun.info 前端代码，-2 为两个站点实测：
 *   3 === code ? "Daily limit reached"
 *   2 === code ? "Too fast, please wait"
 *
 * 注意：「今日已签到」不能只看返回码 —— Railgun 用它自己的码表达，
 * 且前端对任何非 0 返回都会转去查 /user/points 确认。可靠判据是
 * CheckinClient#hasCheckedInToday()。
 */
const CODE = {
  SUCCESS: 0,
  ALREADY_CHECKED_IN: 1,
  TOO_FAST: 2,
  DAILY_LIMIT: 3,
  DEVICE_MISMATCH: 4,
  NO_PERMISSION: -2,
};

/** 视为「签到成功」的消息特征（小写匹配）。中英文站点都覆盖。 */
const SUCCESS_MARKERS = [
  'checkin! got',
  "today's observation logged",
];

/**
 * 服务端文案直接表达「今天已经签过了」的特征。
 *
 * 与 SUCCESS_MARKERS 分开：这不是「刚签到成功」，而是「本次没签、但今天已完成」，
 * 两者对用户的意义不同 —— 后者要明确告诉他账号已经签过了。
 */
const REPEAT_MARKERS = [
  'checkin repeats',
  'please try tomorrow',
];

/** 文案是否表明「今天已经签过了」。 */
function isRepeatByMessage(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const message = String(payload.message || '').toLowerCase();
  return REPEAT_MARKERS.some((marker) => message.includes(marker));
}

/**
 * 文案是否表明「签到 token 不对」。
 *
 * GLaDOS 在 token 与域名不匹配时会回 "please checkin via <域名>"。
 * 这是确定性问题，重试无用，而且**不能**被「今天已签到」的判定掩盖掉 ——
 * 否则用户要等到第二天真失败时才会发现 token 配错了。
 */
function isTokenOutdated(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return String(payload.message || '').toLowerCase().includes('please checkin via');
}

/** 从域名 URL 取出主机名，用于推导签到 token。 */
function hostnameOf(domain) {
  return String(domain)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/** 取不到账号信息时的占位值。 */
const UNKNOWN = '未知';

/** 取「今天」的 YYYY-MM-DD。站点面向中文用户，按北京时间算。 */
function todayString() {
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * 从积分历史里提取「已签到的日期」（YYYY-MM-DD）。
 *
 * 与站点前端 checkedDates 的实现保持一致：
 * 只看 business 含 checkin 且 change > 0 的记录，日期取 detail 开头
 * 或 business 里的 `checkin:YYYY-MM-DD`。
 */
function extractCheckedDates(history) {
  if (!Array.isArray(history)) return [];

  const out = [];
  for (const item of history) {
    if (!item) continue;

    const business = String(item.business || '');
    if (!/checkin/i.test(business)) continue;
    if (!(Number(item.change) > 0)) continue;

    const detail = String(item.detail || '');
    const date = /^\d{4}-\d{2}-\d{2}/.test(detail)
      ? detail.slice(0, 10)
      : (business.match(/checkin[:=](\d{4}-\d{2}-\d{2})/i) || [])[1];

    if (date) out.push(date);
  }
  return out;
}

class CheckinClient {
  /**
   * @param {object} options
   * @param {string} options.cookie   归一化后的 Cookie
   * @param {string[]} options.domains 候选域名（带协议，如 https://glados.cloud）
   * @param {string} [options.checkinToken] 签到 token 覆盖值；留空则按域名推导
   * @param {string} options.userAgent
   * @param {number} options.timeoutMs
   * @param {(msg: string) => void} [options.logger]
   * @param {boolean} [options.debug] 打印每次请求的原始响应，用于排查
   */
  constructor(options) {
    this.cookie = options.cookie;
    this.domains = options.domains.slice();
    this.checkinToken = options.checkinToken || '';
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger || (() => {});
    this.debug = Boolean(options.debug);
    /** 自定义 Authorization 头值；留空则只用 Cookie 鉴权。 */
    this.authorization = options.authorization || '';

    /** 首次成功后记住可用域名，后续请求少走弯路。 */
    this.activeDomain = null;

    // 账号信息（签到后刷新）
    this.email = UNKNOWN;
    this.leftDays = UNKNOWN;
    this.points = UNKNOWN;
    this.pointsChange = UNKNOWN;
    this.exchangeInfo = '';
    this.plan = UNKNOWN;

    // 今日签到状态（来自 /user/points）
    this.checkedIn = false;
    this.today = '';
    this.checkedDates = [];
  }

  /**
   * 是否已经取到账号信息。
   * 等价于「凭证被该站点接受了」—— 体检与归属探测都用它判断。
   */
  hasAccountInfo() {
    return this.email !== UNKNOWN;
  }

  /**
   * 今天是否已经签过。
   *
   * 站点前端在签到返回非 0 时就是这么判断的：转去查 /user/points，
   * 看 `checkedIn` 或历史里有没有今天 —— 两者都说不清才算没签。
   * 之所以不能只看签到返回码：Railgun 的「已签到」并不用成功码表达。
   *
   * @returns {Promise<{done: boolean, basis: string}>} basis 说明判断依据，便于日志交代清楚
   */
  async hasCheckedInToday() {
    await this.fetchPoints();

    if (this.checkedIn) {
      return { done: true, basis: 'points.checkedIn=true' };
    }

    const today = this.today || todayString();
    if (this.checkedDates.indexOf(today) !== -1) {
      return { done: true, basis: '历史记录含 ' + today };
    }

    return { done: false, basis: '' };
  }

  /**
   * 签到 token：显式配置优先，否则用当前域名本身。
   * 站点前端就是发 {token: location.hostname}。
   */
  tokenFor(domain) {
    return this.checkinToken || hostnameOf(domain);
  }

  /** 构造请求头。Origin / Referer 必须与当前域名一致。 */
  buildHeaders(domain, extra) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': this.userAgent,
      Origin: domain,
      Referer: domain + '/console/checkin',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
    // 令牌鉴权的站点可能没有 Cookie，此时不要发空的 Cookie 头
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    // railgun.info 用 Authorization 头鉴权，而不是 Cookie 会话
    if (this.authorization) {
      headers.Authorization = this.authorization;
    }
    return Object.assign(headers, extra || {});
  }

  /**
   * 带域名自动切换的请求。
   * 某个域名网络层失败或返回非 200 时，自动尝试下一个候选域名。
   *
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {object} [opts]
   * @param {object} [opts.json] 固定的 JSON body
   * @param {(domain: string) => object} [opts.jsonForDomain] 按域名生成的 JSON body
   * @param {URLSearchParams} [opts.form] 表单 body（兑换接口用）
   * @returns {Promise<{ok: boolean, status: number, data: any, domain: string, token?: string, error?: string}>}
   */
  async request(method, path, opts) {
    const orders = this.activeDomain
      ? [this.activeDomain].concat(this.domains.filter((d) => d !== this.activeDomain))
      : this.domains.slice();

    let lastError = 'no domain available';

    for (const domain of orders) {
      const url = domain + path;
      let response;
      let sentToken;

      try {
        const init = {
          method: method,
          headers: this.buildHeaders(domain),
          signal: AbortSignal.timeout(this.timeoutMs),
        };

        if (opts && opts.jsonForDomain !== undefined) {
          sentToken = this.tokenFor(domain);
          init.headers['Content-Type'] = 'application/json;charset=UTF-8';
          init.body = JSON.stringify(opts.jsonForDomain(domain));
        } else if (opts && opts.json !== undefined) {
          init.headers['Content-Type'] = 'application/json;charset=UTF-8';
          init.body = JSON.stringify(opts.json);
        } else if (opts && opts.form !== undefined) {
          // 不要手动设 Content-Type，让 fetch 自动带上正确的 boundary
          init.body = opts.form;
        }

        response = await fetch(url, init);
      } catch (err) {
        lastError = domain + ' 请求失败: ' + (err && err.message ? err.message : String(err));
        this.logger('⚠️ ' + lastError);
        continue;
      }

      const text = await response.text();

      // --debug：打印原始响应，排查时最有用（不含 Cookie）
      if (this.debug) {
        const preview = text.length > 600 ? text.slice(0, 600) + '…(截断)' : text;
        this.logger(
          '🐞 ' + method + ' ' + url + ' -> HTTP ' + response.status + ' | ' + preview
        );
      }

      // 网关拦截页等情况会返回 HTML，这里给出可读提示
      if (!response.ok) {
        lastError = domain + ' HTTP ' + response.status;
        this.logger('⚠️ ' + lastError);
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const preview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
        lastError = domain + ' 返回非 JSON: ' + (preview || '(空响应)');
        this.logger('⚠️ ' + lastError);
        continue;
      }

      this.activeDomain = domain;
      return { ok: true, status: response.status, data: data, domain: domain, token: sentToken };
    }

    return { ok: false, status: 0, data: null, domain: '', error: lastError };
  }

  /** 执行签到。token 按实际域名推导。 */
  async checkin() {
    return this.request('POST', '/api/user/checkin', {
      jsonForDomain: (domain) => ({ token: this.tokenFor(domain) }),
    });
  }

  /** 拉取账号状态（邮箱、剩余天数）。 */
  async fetchStatus() {
    const result = await this.request('GET', '/api/user/status');
    if (result.ok && result.data && result.data.data) {
      const d = result.data.data;
      if (d.email) this.email = String(d.email);
      if (d.leftDays !== undefined && d.leftDays !== null) {
        this.leftDays = String(d.leftDays).split('.')[0];
      }
    }
    return result;
  }

  /** 拉取积分、最近变化与可兑换档位。 */
  async fetchPoints() {
    const result = await this.request('GET', '/api/user/points');
    if (result.ok && result.data) {
      const res = result.data;

      if (res.points !== undefined && res.points !== null) {
        this.points = String(res.points).split('.')[0];
      }

      const history = res.history;
      if (Array.isArray(history) && history.length > 0) {
        const change = String(history[0].change || '0').split('.')[0];
        this.pointsChange = change.startsWith('-') ? change : '+' + change;
      }

      // 今日签到状态：签到返回非 0 时靠这几个字段判断今天是否已完成
      this.checkedIn = res.checkedIn === true;
      if (res.today) this.today = String(res.today);
      this.checkedDates = extractCheckedDates(history);

      if (res.plan) this.plan = String(res.plan);
      if (res.plans && typeof res.plans === 'object') {
        const pts = Number.parseInt(this.points, 10);
        this.exchangeInfo = Object.keys(res.plans)
          .map((key) => {
            const item = res.plans[key] || {};
            const need = Number.parseInt(item.points, 10) || 0;
            const days = item.days === undefined ? '?' : item.days;
            return Number.isFinite(pts) && pts >= need
              ? '✅ ' + need + '分→' + days + '天 (可兑换)'
              : '❌ ' + need + '分→' + days + '天 (差' + Math.max(0, need - pts) + '分)';
          })
          .join('\n');
      }
    }
    return result;
  }

  /** 兑换会员天数。表单提交 planType。 */
  async exchange(planId) {
    if (!Object.prototype.hasOwnProperty.call(EXCHANGE_PLANS, planId)) {
      return { ok: false, status: 0, data: null, domain: '', error: '未知兑换档位: ' + planId };
    }
    const form = new URLSearchParams();
    form.append('planType', planId);
    return this.request('POST', '/api/user/exchange', { form: form });
  }
}

/**
 * 判断签到响应本身是否表达了「成功」。
 *
 * 只认 code=0 与已知的成功文案。**不包含**「今日已签到」的判定 ——
 * 那件事必须结合 /user/points 才能下结论（见 hasCheckedInToday），
 * 单看返回码会把 token 失效之类的失败误判成已完成，导致静默漏签。
 *
 * @param {any} payload checkin 接口返回的 JSON
 */
function isSuccessfulCheckin(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (payload.code === CODE.SUCCESS) return true;

  const message = String(payload.message || '').toLowerCase();
  return SUCCESS_MARKERS.some((marker) => message.includes(marker));
}

/**
 * 判断这次响应是否说明凭证有效 —— 能读到账号信息就说明鉴权通过了。
 * 体检（--dry-run）和归属探测都用它。
 *
 * @param {object} result client 的请求结果
 * @param {CheckinClient} client 发起请求的客户端（成功后已带上账号信息）
 */
function isAuthenticated(result, client) {
  if (!result || !result.ok || !client) return false;
  return client.hasAccountInfo();
}

module.exports = {
  CODE,
  SUCCESS_MARKERS,
  REPEAT_MARKERS,
  UNKNOWN,
  hostnameOf,
  todayString,
  extractCheckedDates,
  CheckinClient,
  isSuccessfulCheckin,
  isRepeatByMessage,
  isTokenOutdated,
  isAuthenticated,
};

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
 * 0/1/-2 来自两个站点的实测；2/3 取自 railgun.info 前端代码里的判断：
 *   3 === code ? "Daily limit reached"   // 今日额度已用完 = 今天签过了
 *   2 === code ? "Too fast, please wait"
 */
const CODE = {
  SUCCESS: 0,
  ALREADY_CHECKED_IN: 1,
  TOO_FAST: 2,
  DAILY_LIMIT: 3,
  DEVICE_MISMATCH: 4,
  NO_PERMISSION: -2,
};

/**
 * 按返回码直接判定「今日已签到」的码。
 *
 * 只收 code=3：Railgun 用它表示 "Daily limit reached"，语义明确。
 *
 * 特意【不含】code=1 —— GLaDOS 的 code=1 是双关的：
 * 「已经签过」和「token 错误」都回 1，必须结合 message 才能区分，
 * 否则 token 失效会被误报成「今日已签到」，静默漏签。
 */
const ALREADY_CHECKED_IN_CODES = new Set([CODE.DAILY_LIMIT]);

/** 视为「签到成功」的消息特征（小写匹配）。中英文站点都覆盖。 */
const SUCCESS_MARKERS = [
  'checkin! got',
  'checkin repeats! please try tomorrow',
  "today's observation logged",
];

/** 从域名 URL 取出主机名，用于推导签到 token。 */
function hostnameOf(domain) {
  return String(domain)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/** 取不到账号信息时的占位值。 */
const UNKNOWN = '未知';

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
  }

  /**
   * 是否已经取到账号信息。
   * 等价于「凭证被该站点接受了」—— 体检与归属探测都用它判断。
   */
  hasAccountInfo() {
    return this.email !== UNKNOWN;
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
 * 判断签到响应是否属于「成功」或「今日已签到」这类正常结果。
 *
 * 重复签到不算失败 —— GLaDOS 回 code=1，Railgun 回 code=3（Daily limit reached），
 * 两者都应当作正常结果，否则每天第二次运行就会误报失败并推送告警。
 *
 * @param {any} payload checkin 接口返回的 JSON
 */
function isSuccessfulCheckin(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (payload.code === CODE.SUCCESS) return true;
  if (ALREADY_CHECKED_IN_CODES.has(payload.code)) return true;

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
  ALREADY_CHECKED_IN_CODES,
  SUCCESS_MARKERS,
  UNKNOWN,
  hostnameOf,
  CheckinClient,
  isSuccessfulCheckin,
  isAuthenticated,
};

'use strict';

/**
 * GLaDOS API 客户端。
 *
 * 零依赖：直接用 Node 内置的 fetch（Node 18+），青龙面板无需安装任何依赖。
 * 关键约束（2026 年 API）：
 *   - 签到 token 必须是请求域名本身（如 glados.cloud），旧值 glados.one 已失效
 *   - 必须带 User-Agent，否则服务端无法解析设备，返回 code=4 device-mismatch
 *   - 兑换接口要求表单提交，发 JSON 会被拒
 */

const { EXCHANGE_PLANS } = require('./config');

/** 服务端返回码语义（依据实测与社区抓包整理）。 */
const CODE = {
  SUCCESS: 0,
  ALREADY_CHECKED_IN: 1,
  NO_PERMISSION: -2,
  TOKEN_ERROR: 1,
  DEVICE_MISMATCH: 4,
};

/** 视为「签到成功」的消息特征（小写匹配）。 */
const SUCCESS_MARKERS = [
  'checkin! got',
  'checkin repeats! please try tomorrow',
  "today's observation logged",
];

class GladosClient {
  /**
   * @param {object} options
   * @param {string} options.cookie   归一化后的 Cookie
   * @param {string[]} options.domains 候选域名
   * @param {string} options.checkinToken 签到 token（默认取首个域名）
   * @param {string} options.userAgent
   * @param {number} options.timeoutMs
   * @param {(msg: string) => void} [options.logger]
   */
  constructor(options) {
    this.cookie = options.cookie;
    this.domains = options.domains.slice();
    this.checkinToken = options.checkinToken;
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger || (() => {});

    /** 首次成功后记住可用域名，后续请求少走弯路。 */
    this.activeDomain = null;

    // 账号信息（签到后刷新）
    this.email = '未知';
    this.leftDays = '未知';
    this.points = '未知';
    this.pointsChange = '未知';
    this.exchangeInfo = '';
    this.plan = '未知';
  }

  /** 构造请求头。Origin / Referer 必须与当前域名一致。 */
  buildHeaders(domain, extra) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': this.userAgent,
      Cookie: this.cookie,
      Origin: domain,
      Referer: domain + '/console/checkin',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
    return Object.assign(headers, extra || {});
  }

  /**
   * 带域名自动切换的请求。
   * 某个域名网络层失败或返回非 200 时，自动尝试下一个候选域名。
   *
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {object} [opts]
   * @param {object} [opts.json]   JSON body
   * @param {URLSearchParams} [opts.form] 表单 body（兑换接口用）
   * @returns {Promise<{ok: boolean, status: number, data: any, domain: string, error?: string}>}
   */
  async request(method, path, opts) {
    const orders = this.activeDomain
      ? [this.activeDomain].concat(this.domains.filter((d) => d !== this.activeDomain))
      : this.domains.slice();

    let lastError = 'no domain available';

    for (const domain of orders) {
      const url = domain + path;
      let response;

      try {
        const init = {
          method: method,
          headers: this.buildHeaders(domain),
          signal: AbortSignal.timeout(this.timeoutMs),
        };

        if (opts && opts.json !== undefined) {
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
      return { ok: true, status: response.status, data: data, domain: domain };
    }

    return { ok: false, status: 0, data: null, domain: '', error: lastError };
  }

  /** 执行签到。 */
  async checkin() {
    const result = await this.request('POST', '/api/user/checkin', {
      json: { token: this.checkinToken },
    });
    return result;
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
 * @param {any} payload checkin 接口返回的 JSON
 */
function isSuccessfulCheckin(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (payload.code === CODE.SUCCESS) return true;

  const message = String(payload.message || '').toLowerCase();
  return SUCCESS_MARKERS.some((marker) => message.includes(marker));
}

module.exports = {
  CODE,
  SUCCESS_MARKERS,
  GladosClient,
  isSuccessfulCheckin,
};
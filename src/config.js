'use strict';

/**
 * 配置解析层。
 *
 * 所有配置来自环境变量，便于青龙面板 / Docker / systemd 等场景直接注入。
 * 这里刻意不做任何 I/O，保持纯函数，方便单测。
 */

/** 站点域名候选，按优先级排列。Cookie 与签发域名绑定，逐个试直到通为止。 */
const DEFAULT_DOMAINS = [
  'https://glados.cloud',
  'https://glados.rocks',
  'https://glados.network',
];

/**
 * 签到 token 必须与请求域名一致。
 * GLaDOS 在 2026 年初更新了 API：旧值 glados.one 会返回
 * "please checkin via https://glados.cloud"，签到不会生效。
 */
const DEFAULT_CHECKIN_TOKEN = 'glados.cloud';

/**
 * GLaDOS 从 2026-09 起会校验「签到请求的平台」与「登录时浏览器的平台」。
 * 服务端从 User-Agent 解析平台名，不一致会返回 code=4（device-mismatch）。
 * 所以 UA 必须与当初获取 Cookie 的浏览器平台保持一致。
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 积分兑换档位：planId -> { points, days }。 */
const EXCHANGE_PLANS = {
  plan100: { points: 100, days: 10 },
  plan200: { points: 200, days: 30 },
  plan500: { points: 500, days: 100 },
};

/** 视作「关闭」的取值集合。 */
const DISABLED_VALUES = new Set(['', 'off', 'no', 'none', 'false', '0', 'disabled']);

/**
 * 归一化一条 Cookie 原始串。
 *
 * 兼容几种常见粘贴格式：
 *   1. 标准串   koa:sess=xxx; koa:sess.sig=yyy
 *   2. JSON     {"koa:sess":"xxx","koa:sess.sig":"yyy"} 或 {"token":"xxx"}
 *   3. 裸 JWT   xxx.yyy.zzz
 *   4. 带前缀   Cookie: koa:sess=...
 *
 * @param {string} raw
 * @returns {string|null} 归一化后的 Cookie，无法识别时返回 null
 */
function normalizeCookie(raw) {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value) return null;

  // 去掉可能带上的 "Cookie:" 前缀
  value = value.replace(/^cookie\s*:\s*/i, '').trim();

  // 去掉成对包裹的引号
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return null;

  // 已经是标准 koa:sess 串，直接用
  if (value.includes('koa:sess=')) {
    return value;
  }

  // JSON 形式
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value);
      if (!obj || typeof obj !== 'object') return null;

      if (typeof obj.token === 'string' && obj.token.trim()) {
        return 'koa:sess=' + obj.token.trim();
      }

      const sess = obj['koa:sess'];
      const sig = obj['koa:sess.sig'];
      if (typeof sess === 'string' && sess.trim()) {
        const s = sess.trim();
        return sig && String(sig).trim()
          ? 'koa:sess=' + s + '; koa:sess.sig=' + String(sig).trim()
          : 'koa:sess=' + s;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 裸 JWT：三段点分
  if (value.split('.').length === 3 && !value.includes('=')) {
    return 'koa:sess=' + value;
  }

  // 兜底：原样使用，交给服务端判断
  return value;
}

/**
 * 拆分多账号 Cookie。
 * 支持换行分隔与 & 分隔；Cookie 值本身可能含 &，所以换行优先。
 *
 * @param {string} raw GLADOS_COOKIE 的原始值
 * @returns {string[]} 归一化后的 Cookie 列表
 */
function parseCookies(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];

  const separator = raw.includes('\n') ? '\n' : '&';
  const parts = raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);

  const cookies = [];
  for (const part of parts) {
    const normalized = normalizeCookie(part);
    if (normalized) cookies.push(normalized);
  }
  return cookies;
}

/** 解析布尔型环境变量。 */
function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (DISABLED_VALUES.has(v)) return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 解析正整数环境变量，非法时回落默认值。 */
function parseIntEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * 读取并校验完整配置。
 * @param {Record<string, string|undefined>} env
 */
function loadConfig(env) {
  const source = env || process.env;

  const cookies = parseCookies(source.GLADOS_COOKIE);

  const domains = String(source.GLADOS_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const exchangePlan = (() => {
    const raw = String(source.EXCHANGE_PLAN || 'off')
      .trim()
      .toLowerCase();
    if (DISABLED_VALUES.has(raw)) return null;
    return Object.prototype.hasOwnProperty.call(EXCHANGE_PLANS, raw) ? raw : null;
  })();

  const pushLevel = String(source.PUSH_LEVEL || 'fail_only')
    .trim()
    .toLowerCase();

  return {
    cookies: cookies,
    domains: domains.length > 0 ? domains : DEFAULT_DOMAINS.slice(),
    checkinToken: String(source.GLADOS_CHECKIN_TOKEN || '').trim() || DEFAULT_CHECKIN_TOKEN,
    userAgent: String(source.GLADOS_USER_AGENT || '').trim() || DEFAULT_USER_AGENT,
    timeoutMs: parseIntEnv(source.GLADOS_TIMEOUT_MS, 15000),
    retries: parseIntEnv(source.GLADOS_RETRIES, 3),
    retryDelayMs: parseIntEnv(source.GLADOS_RETRY_DELAY_MS, 20000),
    exchangePlan: exchangePlan,
    pushPlusToken: String(source.PUSHPLUS_TOKEN || '').trim(),
    telegramBotToken: String(source.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: String(source.TELEGRAM_CHAT_ID || '').trim(),
    pushLevel: pushLevel,
    onlyFailPush: pushLevel !== 'all',
    verbose: parseBool(source.GLADOS_VERBOSE, false),
    notifyTitlePrefix: String(source.NOTIFY_TITLE || '').trim() || 'GLaDOS 签到',
  };
}

module.exports = {
  DEFAULT_DOMAINS,
  DEFAULT_CHECKIN_TOKEN,
  DEFAULT_USER_AGENT,
  EXCHANGE_PLANS,
  normalizeCookie,
  parseCookies,
  parseBool,
  parseIntEnv,
  loadConfig,
};
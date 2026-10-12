'use strict';

/**
 * 配置解析层。
 *
 * 配置全部来自青龙面板的环境变量。纯函数、不做 I/O，便于单测。
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
 * 去掉值两端成对包裹的引号。
 *
 * 青龙的「环境变量」输入框不像 shell 那样会剥引号 —— 从文档里
 * 连引号一起粘进去时，引号会成为值本身的一部分，导致 UA 与预期不一致。
 */
function stripQuotes(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Cookie 环境变量的候选名（不同项目的文档用单数/复数都有）。 */
const COOKIE_ENV_NAMES = ['GLADOS_COOKIE', 'GLADOS_COOKIES'];
/** User-Agent 环境变量的候选名。 */
const UA_ENV_NAMES = ['GLADOS_USER_AGENT', 'GLADOS_UA'];

/**
 * 按候选名依次取第一个非空的环境变量并剥掉引号。
 *
 * 支持多个候选名是为了抗「名字差一个字母就完全跑不起来」，
 * 但绝不回落到 COOKIE / UA 这类通用名 —— 青龙的环境变量是全局的，
 * 那样会误抓其他脚本的配置。
 */
function pickEnv(env, names) {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === null) continue;
    const value = stripQuotes(raw);
    if (value) return { name: name, value: value };
  }
  return { name: names[0], value: '' };
}

/**
 * 收集环境里「可能相关」的变量名，用于定位配置问题。
 *
 * 出于安全考虑只返回名字与长度，**不返回值本身** —— 青龙日志可能被他人看到。
 * 名字用 JSON.stringify 输出，以便暴露尾随空格、全角字符之类不可见差异。
 *
 * @param {Record<string, string|undefined>} env
 */
function diagnoseEnv(env) {
  const source = env || process.env;
  const keys = Object.keys(source).sort();
  const pattern = /GLADOS|COOKIE|USER_AGENT|^UA$|_UA$/i;

  const interesting = keys
    .filter((k) => pattern.test(k))
    .map((k) => {
      const v = source[k];
      return { name: k, length: typeof v === 'string' ? v.length : 0 };
    });

  return { total: keys.length, interesting: interesting, names: keys };
}

/**
 * 读取并校验完整配置。
 * @param {Record<string, string|undefined>} env
 */
function loadConfig(env) {
  const source = env || process.env;

  const cookieEnv = pickEnv(source, COOKIE_ENV_NAMES);
  const cookies = parseCookies(cookieEnv.value);

  const uaEnv = pickEnv(source, UA_ENV_NAMES);

  const domains = stripQuotes(source.GLADOS_DOMAINS)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const exchangePlan = (() => {
    const raw = stripQuotes(source.EXCHANGE_PLAN || 'off').toLowerCase();
    if (DISABLED_VALUES.has(raw)) return null;
    return Object.prototype.hasOwnProperty.call(EXCHANGE_PLANS, raw) ? raw : null;
  })();

  const pushLevel = stripQuotes(source.PUSH_LEVEL || 'fail_only').toLowerCase();

  return {
    cookies: cookies,
    cookieEnvName: cookieEnv.name,
    domains: domains.length > 0 ? domains : DEFAULT_DOMAINS.slice(),
    checkinToken: stripQuotes(source.GLADOS_CHECKIN_TOKEN) || DEFAULT_CHECKIN_TOKEN,
    userAgent: uaEnv.value || DEFAULT_USER_AGENT,
    userAgentIsDefault: !uaEnv.value,
    timeoutMs: parseIntEnv(source.GLADOS_TIMEOUT_MS, 15000),
    retries: parseIntEnv(source.GLADOS_RETRIES, 3),
    retryDelayMs: parseIntEnv(source.GLADOS_RETRY_DELAY_MS, 20000),
    exchangePlan: exchangePlan,
    pushPlusToken: stripQuotes(source.PUSHPLUS_TOKEN),
    telegramBotToken: stripQuotes(source.TELEGRAM_BOT_TOKEN),
    telegramChatId: stripQuotes(source.TELEGRAM_CHAT_ID),
    pushLevel: pushLevel,
    onlyFailPush: pushLevel !== 'all',
    verbose: parseBool(source.GLADOS_VERBOSE, false),
    notifyTitlePrefix: stripQuotes(source.NOTIFY_TITLE) || 'GLaDOS 签到',
  };
}

module.exports = {
  DEFAULT_DOMAINS,
  DEFAULT_CHECKIN_TOKEN,
  DEFAULT_USER_AGENT,
  EXCHANGE_PLANS,
  COOKIE_ENV_NAMES,
  UA_ENV_NAMES,
  normalizeCookie,
  parseCookies,
  parseBool,
  parseIntEnv,
  stripQuotes,
  pickEnv,
  diagnoseEnv,
  loadConfig,
};
'use strict';

/**
 * 站点档案。
 *
 * GLaDOS 与 Railgun 是同一套 API 的两个站点，协议完全一致：
 *   POST /api/user/checkin   {token: <当前域名>}
 *   GET  /api/user/status
 *   GET  /api/user/points
 *   POST /api/user/exchange  （表单）
 *
 * 差别只有域名、Cookie 的环境变量名，以及会话字段的名字。
 * 因此签到逻辑共用一份，这里只描述「每个站点长什么样」。
 *
 * 关于 token：站点前端自己发的是 axios.post('/user/checkin', {token: location.hostname})，
 * 也就是【token 恒等于当前请求的域名】。所以 token 由 client 按实际域名推导，
 * 不在这里写死 —— 否则域名回退时会带着旧域名去签到。
 */

const SITES = [
  {
    key: 'glados',
    label: 'GLaDOS',
    /** 候选域名，按顺序尝试。Cookie 与签发站点绑定，不通就换下一个。 */
    hosts: ['glados.cloud', 'glados.rocks', 'glados.network'],
    /** Cookie 环境变量的候选名（单复数都认）。 */
    cookieEnv: ['GLADOS_COOKIE', 'GLADOS_COOKIES'],
    /** User-Agent 环境变量的候选名。 */
    uaEnv: ['GLADOS_USER_AGENT', 'GLADOS_UA'],
    /** 自定义候选域名的变量名（逗号分隔）。 */
    domainsEnv: ['GLADOS_DOMAINS'],
    /** 签到 token 覆盖值。正常情况下不需要配 —— token 由域名自动推导。 */
    tokenEnv: ['GLADOS_CHECKIN_TOKEN'],
    /** 自定义 Authorization 头（仅在站点改用令牌鉴权时才需要）。 */
    authEnv: ['GLADOS_AUTHORIZATION'],
    /** 自动兑换档位的专属变量名（会回落到共用的 EXCHANGE_PLAN）。 */
    exchangeEnv: ['GLADOS_EXCHANGE_PLAN'],
    /**
     * 会话字段提示：缺了这个字段基本签不上。
     * GLaDOS 2026-09 起改用 gld:sess / gld:sess.sig。
     * 只用于给出提示，不做拦截。
     */
    /**
     * 会话字段提示：只要命中其中之一就不提示。
     * GLaDOS 2026-09 起改用 gld:sess / gld:sess.sig，旧的 koa:* 不再够用。
     * 仅用于给出提示，不做拦截。
     */
    sessionFields: ['gld:sess'],
    sessionHint: 'GLaDOS 2026-09 起改用 gld:sess + gld:sess.sig，只有旧的 koa:sess 会返回「没有权限」',
    sessionHowTo: '请在签到页 Network 里，从 status 请求的 Request Headers 中【整段复制】Cookie',
  },
  {
    key: 'railgun',
    label: 'Railgun',
    hosts: ['railgun.info'],
    cookieEnv: ['RAILGUN_COOKIE', 'RAILGUN_COOKIES'],
    uaEnv: ['RAILGUN_USER_AGENT', 'RAILGUN_UA'],
    domainsEnv: ['RAILGUN_DOMAINS'],
    tokenEnv: ['RAILGUN_CHECKIN_TOKEN'],
    /**
     * 设备指纹，放在 Authorization 头里。
     *
     * 注意：这不是登录令牌，而是浏览器指纹。前端代码是
     *   Ta = getCanvasFingerprint() + "-" + screen.height + "-" + screen.width
     * 形如 `<画布哈希>-1080-1920`，同一个浏览器基本不变（不会像会话那样过期）。
     *
     * 服务端很可能把会话与指纹绑定。只带 Cookie 不带指纹时，请求看起来
     * 像「另一台设备」，可能因此被拒。所以这一项建议配上：
     * 从浏览器任意一个 /api/user/... 请求的 Request Headers 里复制即可。
     */
    authEnv: ['RAILGUN_AUTHORIZATION'],
    exchangeEnv: ['RAILGUN_EXCHANGE_PLAN'],
    /**
     * 会话字段：railgun 的字段名没有权威来源，所以新旧两种都接受，
     * 命中任一就不提示，避免误报。
     */
    sessionFields: ['koa:sess', 'gld:sess'],
    sessionHint: 'Railgun 的会话字段没有明确文档，新旧命名都可能',
    sessionHowTo: '请从 railgun.info 的任意 /api/user/... 请求里【整段复制】Cookie',
    /**
     * 该站点的 Authorization 是设备指纹而非令牌，配不上不会报「令牌无效」，
     * 而是会话被当成别的设备 —— 单独提示一下，避免误解。
     */
    authNote: '这是设备指纹（不是令牌），从浏览器请求头原样复制，长期有效',
  },
];

/** 按 key 取站点档案。 */
function getSite(key) {
  return SITES.find((site) => site.key === key) || null;
}

module.exports = { SITES, getSite };

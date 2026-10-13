'use strict';

/**
 * 排查工具：环境诊断、Cookie 解析自证、站点归属探测。
 *
 * 全部是只读的，不参与正常签到，也不会改动任何账号状态。
 */

const { loadConfig, diagnoseEnv } = require('./config');
const { CheckinClient, hostnameOf, isAuthenticated } = require('./client');
const { SITES } = require('./sites');

/**
 * 把 Cookie 拆成「字段名 + 值长度」。
 * 刻意不返回字段值 —— 这些输出经常要贴到公开场合求助。
 */
function parseCookieFields(cookie) {
  return String(cookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return { name: name, length: value.length };
    });
}

/** 一行式字段摘要，形如 `koa:sess(268)  koa:sess.sig(43)`。 */
function formatCookieFields(cookie) {
  const fields = parseCookieFields(cookie);
  if (fields.length === 0) return '(空)';
  return fields.map((f) => f.name + '(' + f.length + ')').join('  ');
}

/**
 * 环境诊断：变量「明明配了却读不到」时，把环境里有什么列出来。
 *
 * 只输出变量名与长度，绝不输出值 —— 青龙日志可能被他人看到。
 */
function reportEnvDiagnosis(log, expectedEnvNames) {
  const diag = diagnoseEnv(process.env);

  log('🔍 环境诊断（只列变量名与长度，不打印值）:');
  log('   环境变量总数: ' + diag.total);

  if (diag.interesting.length > 0) {
    for (const item of diag.interesting) {
      // JSON.stringify 能把尾随空格等不可见字符显示出来
      log('   ' + JSON.stringify(item.name) + '  值长度=' + item.length);
    }
    log('   ↑ 名字若与 ' + expectedEnvNames.join(' / ') + ' 有差异（尾随空格 / 大小写 / 单复数），请改成一致');
    log('     值长度为 0 说明变量建了但值没保存进去');
    return;
  }

  log('   ⚠️ 没有任何变量名包含 GLADOS / RAILGUN / COOKIE / USER_AGENT');
  log('   下面是当前全部变量名，请在列表中查找你的变量：');
  log('');
  for (const name of diag.names) {
    log('     ' + JSON.stringify(name));
  }
  log('');
  log('   若列表中找不到，请检查：');
  log('   ① 该变量在青龙「环境变量」里是否处于【启用】状态');
  log('   ② 变量名是否符合青龙规范：只能含字母/数字/下划线，且以字母或下划线开头');
  log('      （不符合规范的名字会被青龙静默丢弃，但面板里照常显示）');
  log('   ③ 变量是否加在了当前这个青龙实例上');
}

/**
 * Cookie 自证：确认脚本没有改动用户粘进来的 Cookie。
 *
 * 只要「归一化后的长度」与「环境变量里的原始长度」一致，就说明 Cookie
 * 是原样发出去的 —— 这样就能把排查方向从脚本转到凭证本身。
 */
function logCookieDiagnosis(env, config, log) {
  const envName = config.site.cookieEnv[0];
  const raw = env[envName] === undefined ? '' : String(env[envName]);
  const normalized = config.cookies[0] || '';
  const sameLength = raw.trim().length === normalized.length;

  log('🍪 Cookie 解析诊断 [' + config.site.label + ']');
  log('   环境变量原始长度: ' + raw.trim().length);
  log('   实际发出长度:     ' + normalized.length);
  log(
    '   ' +
      (sameLength
        ? '✅ 长度一致，Cookie 未被脚本改动'
        : '⚠️ 长度不一致 —— 脚本对 Cookie 做了处理，请把这条发给作者')
  );
  log('   字段: ' + formatCookieFields(normalized));
}

/**
 * 归属探测：把已配置的 Cookie 逐个拿到每个站点的每个域名上试一次。
 *
 * 凭证是按站点签发的，同一份在 A 站通过、在 B 站被拒都属正常。
 * 迁移期间「账号到底在哪边」用这个一次就能看出来。
 *
 * @returns {Promise<number>} 0 表示至少有一组通过
 */
async function probeSites(env, log) {
  const allConfigs = SITES.map((profile) => loadConfig(env, profile));

  // 收集去重后的 Cookie，并记住它来自哪个环境变量
  const cookies = new Map();
  for (const config of allConfigs) {
    for (const cookie of config.cookies) {
      if (!cookies.has(cookie)) cookies.set(cookie, config.cookieEnvName);
    }
  }

  if (cookies.size === 0) {
    log('❌ 没有读到任何 Cookie —— 先配 GLADOS_COOKIE 或 RAILGUN_COOKIE');
    return 1;
  }

  log('🔍 凭证归属探测（只读，不签到、不兑换）');
  log('');

  let anyOk = false;
  let index = 0;

  for (const [cookie, sourceName] of cookies) {
    index += 1;
    log('🍪 凭证 #' + index + '（来自 ' + sourceName + '）');
    log('   字段: ' + formatCookieFields(cookie));

    for (const config of allConfigs) {
      for (const domain of config.domains) {
        const client = new CheckinClient({
          cookie: cookie,
          domains: [domain],
          authorization: config.authorization,
          userAgent: config.userAgent,
          timeoutMs: config.timeoutMs,
          logger: () => {},
        });

        const res = await client.fetchStatus();
        const accepted = isAuthenticated(res, client);
        if (accepted) anyOk = true;

        log(
          '   ' + (accepted ? '✅' : '❌') + ' ' +
            (config.site.label + ' @ ' + hostnameOf(domain)).padEnd(30) +
            ' -> ' + describeProbe(res, client, accepted)
        );
      }
    }
    log('');
  }

  log('说明：凭证按站点签发 —— 同一份在各站点表现不同是正常的。');
  log('      出现 ✅ 的那一行，就是该账号当前所在的站点。');
  return anyOk ? 0 : 1;
}

/** 探测结果的一行描述。 */
function describeProbe(res, client, accepted) {
  if (!res.ok) return res.error || '请求失败';
  if (accepted) {
    return (
      'code=0  邮箱 ' + client.email +
      '  积分 ' + client.points +
      '  剩余 ' + client.leftDays + ' 天'
    );
  }
  const code = res.data ? res.data.code : undefined;
  const message = (res.data && res.data.message) || '';
  return 'code=' + (code === undefined ? '?' : code) + '  ' + message;
}

module.exports = {
  parseCookieFields,
  formatCookieFields,
  reportEnvDiagnosis,
  logCookieDiagnosis,
  probeSites,
};

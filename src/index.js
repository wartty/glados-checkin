#!/usr/bin/env node
'use strict';

/**
 * GLaDOS / Railgun 自动签到 —— 青龙面板入口
 *
 * 两个站点共用这一份脚本：配了哪个站点的凭证就签到哪个。
 * 只配 GLADOS_COOKIE 时，行为与纯 GLaDOS 版本一致。
 *
 * 零依赖，Node 18+ 直接运行，青龙面板无需安装任何依赖。
 *
 * 青龙定时任务命令（相对 /ql/scripts）：
 *   task glados-checkin/src/index.js
 *
 * 可选参数（青龙里也可用对应环境变量）：
 *   --dry-run / --check     只读体检：不签到、不兑换、不推送，不消耗当天签到
 *   --probe                 凭证归属探测：判断某份凭证属于哪个站点
 *   --debug                 打印每次请求的原始响应与 Cookie 解析诊断
 *   CHECKIN_DRY_RUN=1       同 --dry-run
 *   CHECKIN_DEBUG=1         同 --debug
 *
 * 退出码：
 *   0  全部账号成功（含「今日已签到」）
 *   1  存在失败账号 / 配置缺失 / 网络异常
 */

const { loadSites, EXCHANGE_PLANS } = require('./config');
const { runCheckin } = require('./checkin');
const { probeSites, reportEnvDiagnosis, logCookieDiagnosis } = require('./diagnose');
const { buildReport, dispatch } = require('./notify');

/** 带时间戳的日志输出（北京时间）。 */
function makeLogger() {
  return (msg) => {
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log('[' + ts + '] ' + msg);
  };
}

/** 解析命令行参数与环境变量开关。 */
function parseFlags(argv, env) {
  const has = (name) => argv.includes(name);
  const on = (value) => /^(1|true|yes|on)$/i.test(String(value === undefined ? '' : value));

  return {
    probe: has('--probe'),
    dryRun: has('--dry-run') || has('--check') || on(env.CHECKIN_DRY_RUN),
    debug: has('--debug') || on(env.CHECKIN_DEBUG),
  };
}

/** 打印单个站点的配置摘要。 */
function logSiteSummary(config, log) {
  const site = config.site;
  const accountCount = config.cookies.length > 0 ? config.cookies.length : 1;

  log('🌐 ' + site.label + ' | 账号数 ' + accountCount + ' | 域名 ' + config.domains.join(', '));

  const authParts = [];
  if (config.cookies.length > 0) authParts.push('Cookie');
  if (config.authorization) {
    authParts.push('Authorization 头（已配置，' + config.authorization.length + ' 字符）');
  }
  log('   鉴权: ' + authParts.join(' + '));

  if (config.authorization && site.authNote) {
    log('         ' + site.authNote);
  } else if (!config.authorization && site.authEnv && site.authEnv.length > 0 && site.authNote) {
    log('   💡 未配 ' + site.authEnv[0] + ' —— ' + site.authNote);
  }

  log(
    '   User-Agent(' +
      (config.userAgentIsDefault ? '内置默认' : '环境变量') +
      '): ' + config.userAgent
  );

  // 会话字段提示：命中任一候选字段就不提示，避免误报
  const expected = site.sessionFields || [];
  if (expected.length > 0) {
    const missing = config.cookies.filter((c) => c && !expected.some((f) => c.includes(f)));
    if (missing.length > 0) {
      log(
        '   ⚠️ 有 ' + missing.length + '/' + config.cookies.length +
          ' 个凭证里没有 ' + expected.join(' 或 ')
      );
      log('      ' + site.sessionHint);
      if (site.sessionHowTo) log('      ' + site.sessionHowTo);
    }
  }

  if (config.exchangePlan) {
    const plan = EXCHANGE_PLANS[config.exchangePlan];
    log('   🎁 自动兑换已启用: ' + plan.points + '分 → ' + plan.days + '天');
  }
}

/** 按推送设置决定是否推送，并给出汇总。 */
async function reportResults(sites, accounts, allOk, log) {
  // 推送设置是全局的，取任一站点配置即可
  const settings = sites[0];
  const exchangeFailed = accounts.some(
    (a) => a.exchangeResult && a.exchangeResult.startsWith('⚠️')
  );
  const shouldPush = !settings.onlyFailPush || !allOk || exchangeFailed;

  if (!shouldPush) {
    log('ℹ️ PUSH_LEVEL=fail_only 且全部成功，跳过推送');
    return;
  }

  const titlePrefix =
    settings.notifyTitlePrefix || sites.map((c) => c.site.label).join(' + ') + ' 签到';
  await dispatch(settings, buildReport(accounts, { titlePrefix: titlePrefix }), log);
}

async function main() {
  const log = makeLogger();
  const flags = parseFlags(process.argv, process.env);

  // 探测模式优先级最高：只读判断「这份凭证属于哪个站点」
  if (flags.probe) {
    return probeSites(process.env, log);
  }

  const sites = loadSites(process.env);

  log(flags.dryRun ? '🔎 只读体检模式（不会签到，不消耗当天签到）' : '🚀 签到启动');
  if (flags.debug) log('🐞 调试模式：会打印每次请求的原始响应（不含凭证）');

  if (sites.length === 0) {
    log('❌ 没有读到任何凭证 —— GLADOS_COOKIE / RAILGUN_COOKIE 都不存在或为空');
    log('');
    reportEnvDiagnosis(log, ['GLADOS_COOKIE', 'RAILGUN_COOKIE']);
    return 1;
  }

  // 自证：确认脚本没有改动用户粘进来的 Cookie
  if (flags.debug) {
    for (const config of sites) {
      logCookieDiagnosis(process.env, config, log);
    }
    log('');
  }

  log(
    '📋 待' + (flags.dryRun ? '体检' : '签到') + '站点: ' +
      sites.map((c) => c.site.label).join(' + ')
  );
  log('');
  for (const config of sites) {
    logSiteSummary(config, log);
  }
  log('');

  const accounts = await runCheckin(sites, {
    log: log,
    dryRun: flags.dryRun,
    debug: flags.debug,
  });

  const successCount = accounts.filter((a) => a.success).length;
  const allOk = successCount === accounts.length;

  log(
    '📊 ' + (flags.dryRun ? '体检完成: 凭证可用 ' : '完成: 成功 ') +
      successCount + '/' + accounts.length
  );

  // 体检只是排查手段，不发推送
  if (flags.dryRun) {
    log('ℹ️ 体检模式不发推送。去掉 --dry-run 即可正常签到。');
    return allOk ? 0 : 1;
  }

  await reportResults(sites, accounts, allOk, log);
  return allOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[签到] 致命错误:', err);
    process.exitCode = 1;
  });

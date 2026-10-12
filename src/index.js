#!/usr/bin/env node
'use strict';

/**
 * GLaDOS 自动签到 —— 青龙面板 / 通用 Node 脚本入口
 *
 * 零依赖，Node 18+ 直接运行，青龙面板无需安装任何依赖。
 *
 * 用法：
 *   GLADOS_COOKIE="koa:sess=xxx; koa:sess.sig=yyy" node src/index.js
 *
 * 退出码：
 *   0  全部账号签到成功（或今日已签到）
 *   1  存在失败账号 / 配置缺失 / 网络异常
 */

const { loadConfig, diagnoseEnv, EXCHANGE_PLANS } = require('./config');
const { GladosClient, isSuccessfulCheckin, CODE } = require('./glados');
const { buildReport, dispatch } = require('./notify');

/** 带时间戳的日志输出（北京时间）。 */
function makeLogger() {
  return (msg) => {
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log('[' + ts + '] ' + msg);
  };
}

/** 等待若干毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带重试的签到。
 * 只对「非正常结果」重试；成功或今日已签到立即返回，避免重复请求。
 *
 * @returns {Promise<{result: any, success: boolean}>}
 */
async function checkinWithRetry(client, retries, retryDelayMs, log) {
  const attempts = Math.max(1, retries);
  let last = null;

  for (let i = 1; i <= attempts; i += 1) {
    last = await client.checkin();

    if (last.ok && isSuccessfulCheckin(last.data)) {
      return { result: last, success: true };
    }

    // code=4 设备校验失败属于确定性问题，重试也无效，直接放弃
    if (last.ok && last.data && last.data.code === CODE.DEVICE_MISMATCH) {
      log('⛔ 设备校验未通过，重试无意义，跳过');
      return { result: last, success: false };
    }

    if (i < attempts) {
      log('⚠️ 签到第 ' + i + '/' + attempts + ' 次未成功，' + Math.round(retryDelayMs / 1000) + ' 秒后重试');
      await sleep(retryDelayMs);
    }
  }

  return { result: last, success: false };
}

/**
 * 根据签到响应推导一条给用户看的结果描述。
 */
function describeResult(result) {
  if (!result || !result.ok) {
    return { message: '网络异常: ' + ((result && result.error) || '未知错误'), success: false };
  }

  const data = result.data || {};
  const success = isSuccessfulCheckin(data);
  const message = String(data.message || '无返回信息');

  if (success) {
    // 统一把英文原文翻译成中文，同时保留原文便于排查
    const lower = message.toLowerCase();
    if (lower.includes('repeats')) return { message: '今日已签到', success: true };
    return { message: '签到成功 — ' + message, success: true };
  }

  if (data.code === CODE.DEVICE_MISMATCH) {
    return {
      message:
        '设备校验失败 (device-mismatch)：登录设备 ' +
        (data.loginDevice || '?') +
        '，当前请求 ' +
        (data.currentDevice || '空') +
        '。请把 GLADOS_USER_AGENT 设成与登录时相同的浏览器 UA',
      success: false,
    };
  }

  if (data.code === CODE.NO_PERMISSION) {
    return { message: 'Cookie 失效或无权限，请重新获取 (code=-2)', success: false };
  }

  return { message: message + ' (code=' + (data.code === undefined ? '未知' : data.code) + ')', success: false };
}

/**
 * 处理单个账号：签到 -> 刷新信息 -> 可选兑换。
 */
async function processAccount(cookie, index, config, log) {
  const client = new GladosClient({
    cookie: cookie,
    domains: config.domains,
    checkinToken: config.checkinToken,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    logger: log,
  });

  log('▶️ 账号 ' + index + ' 开始签到');

  const outcome = await checkinWithRetry(client, config.retries, config.retryDelayMs, log);
  const described = describeResult(outcome.result);

  // 无论签到成败都尝试拉取账号信息，便于判断 Cookie 是否有效
  await client.fetchStatus();
  await client.fetchPoints();

  const account = {
    email: client.email,
    points: client.points,
    pointsChange: client.pointsChange,
    leftDays: client.leftDays,
    exchangeInfo: client.exchangeInfo,
    message: described.message,
    success: described.success,
  };

  log(
    (described.success ? '✅' : '❌') +
      ' 账号 ' +
      index +
      ' | 积分: ' +
      client.points +
      ' | 天数: ' +
      client.leftDays +
      ' | ' +
      described.message
  );

  // 积分自动兑换：在签到之后执行，让当天新赚的积分也计入阈值
  if (config.exchangePlan && described.success) {
    account.exchangeResult = await autoExchange(client, config.exchangePlan, log);
  }

  return account;
}

/**
 * 积分达标时自动兑换会员天数。
 * @returns {Promise<string>} 用于推送的说明文本
 */
async function autoExchange(client, planId, log) {
  const plan = EXCHANGE_PLANS[planId];
  if (!plan) return '⏭️ 未配置有效兑换档位';

  const points = Number.parseInt(client.points, 10);
  if (!Number.isFinite(points)) return '⚠️ 兑换跳过（积分未知）';
  if (points < plan.points) {
    return '⏭️ 积分不足 (' + points + '/' + plan.points + ')，攒够自动兑换 ' + plan.days + ' 天';
  }

  const res = await client.exchange(planId);
  const ok = res.ok && res.data && res.data.code === CODE.SUCCESS;

  if (ok) {
    log('🎁 自动兑换成功: ' + plan.points + '分 → +' + plan.days + '天');
    // 兑换会扣积分、加天数，刷新后推送里才是最新数据
    await client.fetchStatus();
    await client.fetchPoints();
    return '🎁 兑换成功 +' + plan.days + ' 天 (消耗 ' + plan.points + ' 分)';
  }

  const reason = res.ok && res.data ? res.data.message : (res.error || '网络错误');
  log('⚠️ 自动兑换失败: ' + reason);
  return '⚠️ 兑换失败 (' + reason + ')';
}

async function main() {
  const log = makeLogger();
  const config = loadConfig(process.env);

  log('🚀 GLaDOS 签到启动');

  if (config.cookies.length === 0) {
    log('❌ 读不到 Cookie —— 环境变量 ' + config.cookieEnvName + ' 不存在或为空');
    log('');

    const diag = diagnoseEnv(process.env);
    log('🔍 环境诊断（只列变量名与长度，不打印值）:');
    log('   环境变量总数: ' + diag.total);

    if (diag.interesting.length > 0) {
      for (const item of diag.interesting) {
        // JSON.stringify 能把尾随空格等不可见字符显示出来
        log('   ' + JSON.stringify(item.name) + '  值长度=' + item.length);
      }
      log('   ↑ 名字若与 ' + config.cookieEnvName + ' 有差异（尾随空格 / 大小写 / 单复数），请改成一致');
      log('     值长度为 0 说明变量建了但值没保存进去');
    } else {
      log('   ⚠️ 没有任何变量名包含 GLADOS / COOKIE / USER_AGENT');
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
    return 1;
  }

  log('📋 账号数: ' + config.cookies.length + ' | 域名: ' + config.domains.join(', '));
  log(
    '🖥️ User-Agent(' +
      (config.userAgentIsDefault ? '内置默认' : '环境变量') +
      '): ' +
      config.userAgent
  );

  // 2026-09 起会话字段改为 gld:sess / gld:sess.sig，只有旧的 koa:* 会一直返回 code=-2。
  // 这里只提示、不拦截 —— 万一站点回退到旧字段，脚本仍能正常工作。
  const missingGld = config.cookies.filter((c) => !c.includes('gld:sess'));
  if (missingGld.length > 0) {
    log('⚠️ 有 ' + missingGld.length + '/' + config.cookies.length + ' 个 Cookie 里没有 gld:sess');
    log('   GLaDOS 2026-09 起改用 gld:sess + gld:sess.sig，只有旧的 koa:sess 会返回「没有权限」(code=-2)');
    log('   请在签到页 Network 里【整段复制】Cookie，确认同时含这两个字段');
  }

  if (config.exchangePlan) {
    const p = EXCHANGE_PLANS[config.exchangePlan];
    log('🎁 自动兑换已启用: ' + p.points + '分 → ' + p.days + '天');
  }

  const accounts = [];
  for (let i = 0; i < config.cookies.length; i += 1) {
    try {
      accounts.push(await processAccount(config.cookies[i], i + 1, config, log));
    } catch (err) {
      // 单账号异常不应影响其他账号
      log('❌ 账号 ' + (i + 1) + ' 处理异常: ' + (err && err.message ? err.message : String(err)));
      accounts.push({
        email: '未知',
        points: '未知',
        pointsChange: '未知',
        leftDays: '未知',
        message: '异常: ' + (err && err.message ? err.message : String(err)),
        success: false,
      });
    }
  }

  const successCount = accounts.filter((a) => a.success).length;
  const allOk = successCount === accounts.length;

  log('📊 完成: 成功 ' + successCount + '/' + accounts.length);

  const exchangeFailed = accounts.some((a) => a.exchangeResult && a.exchangeResult.startsWith('⚠️'));
  const shouldPush = !config.onlyFailPush || !allOk || exchangeFailed;

  if (shouldPush) {
    const report = buildReport(accounts, { titlePrefix: config.notifyTitlePrefix });
    await dispatch(config, report, log);
  } else {
    log('ℹ️ PUSH_LEVEL=fail_only 且全部成功，跳过推送');
  }

  return allOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[GLaDOS] 致命错误:', err);
    process.exitCode = 1;
  });
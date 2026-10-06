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

const { loadConfig, EXCHANGE_PLANS } = require('./config');
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
    log('❌ 未配置 GLADOS_COOKIE，退出');
    log('   请在青龙面板「环境变量」中添加，格式: koa:sess=xxx; koa:sess.sig=yyy');
    return 1;
  }

  log('📋 账号数: ' + config.cookies.length + ' | 域名: ' + config.domains.join(', '));
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
'use strict';

/**
 * 签到流程。
 *
 * 只负责「把签到做完」：重试策略、单账号处理、可选自动兑换。
 * 日志汇报与推送在 index.js，排查工具在 diagnose.js。
 */

const { EXCHANGE_PLANS } = require('./config');
const {
  CheckinClient,
  isSuccessfulCheckin,
  isRepeatByMessage,
  isTokenOutdated,
  UNKNOWN,
  CODE,
} = require('./client');

/** 等待若干毫秒。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 是否为「重试也没用」的确定性失败：
 *   code=4  设备校验不通过（UA 平台 / 指纹与登录时不一致）
 *   code=-2 凭证失效或无权限
 * 这类问题重试只会白等，还会增加被限流的风险。
 */
function isDeterministicFailure(data) {
  if (!data) return false;
  return data.code === CODE.DEVICE_MISMATCH || data.code === CODE.NO_PERMISSION;
}

/**
 * 带重试的签到。
 *
 * 三种情况立即返回，不浪费重试次数：
 *   1. 刚签到成功
 *   2. 今天已经签过了（本次没签成，但不是失败；依据随结果返回，由结果行输出）
 *   3. 确定性失败（凭证失效 / 设备校验 / token 失效）
 *
 * @returns {Promise<{result: object|null, success: boolean, alreadyCheckedIn?: boolean, basis?: string}>}
 */
async function checkinWithRetry(client, retries, retryDelayMs, log) {
  const attempts = Math.max(1, retries);
  let last = null;

  for (let i = 1; i <= attempts; i += 1) {
    last = await client.checkin();

    if (!last.ok) {
      if (i < attempts) {
        log('第 ' + i + '/' + attempts + ' 次未成功，' + Math.round(retryDelayMs / 1000) + ' 秒后重试');
        await sleep(retryDelayMs);
      }
      continue;
    }

    // 今天已经签过了 —— 先看服务端文案（GLaDOS 走这条）。
    // 不在这里打日志：依据会随结果返回，由结果行统一输出，避免重复。
    if (isRepeatByMessage(last.data)) {
      const basis = '服务端返回「' + String(last.data.message || '').trim() + '」';
      return { result: last, success: true, alreadyCheckedIn: true, basis: basis };
    }

    if (isSuccessfulCheckin(last.data)) {
      return { result: last, success: true };
    }

    // token 不对是确定性问题：先于「已签到」判定拦下，避免被今天已签到掩盖。
    // 不打跳过日志 —— 结果行会带出失败原因，避免重复。
    if (isTokenOutdated(last.data)) {
      return { result: last, success: false };
    }

    if (isDeterministicFailure(last.data)) {
      return { result: last, success: false };
    }

    // 文案没说清楚的（Railgun 就是这种）：照站点前端的做法查 /user/points，
    // 靠 checkedIn / 历史日期确认。否则每天第二次运行都会误报失败。
    const check = await client.hasCheckedInToday();
    if (check.done) {
      return { result: last, success: true, alreadyCheckedIn: true, basis: check.basis };
    }

    if (i < attempts) {
      log('第 ' + i + '/' + attempts + ' 次未成功，' + Math.round(retryDelayMs / 1000) + ' 秒后重试');
      await sleep(retryDelayMs);
    }
  }

  return { result: last, success: false };
}

/**
 * 根据签到响应推导一条给用户看的结果描述。
 *
 * @param {object} result 一次请求的结果
 * @param {object} site   站点档案，用于在提示里给出正确的变量名
 */
function describeResult(result, site) {
  if (!result || !result.ok) {
    return { message: '网络异常: ' + ((result && result.error) || '未知错误'), success: false };
  }

  const data = result.data || {};
  const message = String(data.message || '无返回信息');

  if (isSuccessfulCheckin(data)) {
    return { message: '签到成功 — ' + message, success: true };
  }

  if (data.code === CODE.DEVICE_MISMATCH) {
    const uaVar = (site && site.uaEnv && site.uaEnv[0]) || 'USER_AGENT';
    return {
      message:
        '设备校验失败 (device-mismatch)：登录设备 ' +
        (data.loginDevice || '?') +
        '，当前请求 ' +
        (data.currentDevice || '空') +
        '。请把 ' +
        uaVar +
        ' 设成与登录时相同的浏览器 UA',
      success: false,
    };
  }

  if (data.code === CODE.NO_PERMISSION) {
    return { message: '凭证失效或无权限，请重新获取 (code=-2)', success: false };
  }

  if (isTokenOutdated(data)) {
    return {
      message:
        '签到 token 与站点不符（服务端返回：' + message +
        '）—— 用 <站点>_CHECKIN_TOKEN 覆盖为上面那个域名',
      success: false,
    };
  }

  if (data.code === CODE.TOO_FAST) {
    return { message: '请求过快被限流（' + message + '），可稍后重试', success: false };
  }

  if (data.code === CODE.DAILY_LIMIT) {
    // 走到这里说明 /user/points 也没显示今天签过，不能当成已签到放过
    return {
      message: '服务端提示额度已用完，但 points 显示今天未签到 —— 请人工确认（' + message + '）',
      success: false,
    };
  }

  // 未识别的返回：把原始响应带上，失败日志本身就能用来定位
  const code = data.code === undefined ? '?' : data.code;
  return {
    message: message + ' (code=' + code + ')  原始响应: ' + compactJson(data),
    success: false,
  };
}

/** 把响应压成一行短文本，供日志使用。 */
function compactJson(value) {
  try {
    const text = JSON.stringify(value);
    if (!text) return String(value);
    return text.length > 240 ? text.slice(0, 240) + '…' : text;
  } catch {
    return '(无法序列化)';
  }
}

/**
 * 积分达标时自动兑换会员天数。
 *
 * @returns {Promise<{status: 'ok'|'fail'|'skip', text: string}>}
 *   status 用于推送决策：fail 时即使 PUSH_LEVEL=fail_only 也会推送；
 *   skip（积分不足等）不打扰。text 进推送的「自动兑换」一行。
 */
async function autoExchange(client, planId, log) {
  const plan = EXCHANGE_PLANS[planId];
  if (!plan) return { status: 'skip', text: '未配置有效兑换档位' };

  const points = Number.parseInt(client.points, 10);
  if (!Number.isFinite(points)) return { status: 'fail', text: '兑换跳过（积分未知）' };
  if (points < plan.points) {
    return {
      status: 'skip',
      text: '积分不足 (' + points + '/' + plan.points + ')，攒够自动兑换 ' + plan.days + ' 天',
    };
  }

  const res = await client.exchange(planId);
  if (res.ok && res.data && res.data.code === CODE.SUCCESS) {
    log('自动兑换成功: ' + plan.points + '分 → +' + plan.days + '天');
    // 兑换会扣积分、加天数，刷新后推送里才是最新数据
    await client.fetchStatus();
    await client.fetchPoints();
    return { status: 'ok', text: '兑换成功 +' + plan.days + ' 天 (消耗 ' + plan.points + ' 分)' };
  }

  const reason = res.ok && res.data ? res.data.message : (res.error || '网络错误');
  log('自动兑换失败: ' + reason);
  return { status: 'fail', text: '兑换失败 (' + reason + ')' };
}

/** 构造一个账号的结果条目。 */
function buildAccount(config, index, described, client) {
  return {
    site: config.site.label,
    email: client ? client.email : UNKNOWN,
    points: client ? client.points : UNKNOWN,
    pointsChange: client ? client.pointsChange : UNKNOWN,
    leftDays: client ? client.leftDays : UNKNOWN,
    exchangeInfo: client ? client.exchangeInfo : '',
    message: described.message,
    success: described.success,
  };
}

/**
 * 处理单个账号：签到（或只读体检）-> 刷新信息 -> 可选兑换。
 *
 * @param {string} cookie 归一化后的 Cookie；令牌鉴权的站点可能为空串
 * @param {number} index  账号序号（站点内）
 * @param {object} config 该站点的配置
 * @param {(msg: string) => void} log
 * @param {{dryRun?: boolean, debug?: boolean}} options
 */
async function processAccount(cookie, index, config, log, options) {
  const opts = options || {};
  const site = config.site;

  // 本账号的所有日志都带上站点与序号，多账号时才分得清归属
  const plog = (msg) => log('[' + site.label + ' 账号' + index + '] ' + msg);

  const client = new CheckinClient({
    cookie: cookie,
    domains: config.domains,
    checkinToken: config.checkinToken,
    authorization: config.authorization,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    logger: plog,
    debug: opts.debug,
  });

  let checkinResult = null;
  let already = null;

  if (!opts.dryRun) {
    const outcome = await checkinWithRetry(client, config.retries, config.retryDelayMs, plog);
    checkinResult = outcome.result;
    if (outcome.alreadyCheckedIn) already = { basis: outcome.basis || '' };
  }

  // 无论签到成败都拉一次账号信息：既用于汇报，也能判断凭证是否有效
  await client.fetchStatus();
  await client.fetchPoints();

  let described;
  if (opts.dryRun) {
    // 体检模式：能读到账号信息就说明该站点接受了这份凭证
    described = client.hasAccountInfo()
      ? { message: '体检通过，凭证有效（本次未签到）', success: true }
      : {
          message: '体检失败：该站点拒绝此凭证 (code=-2)，可能已失效或账号不在 ' + site.label,
          success: false,
        };
  } else if (already) {
    // 签到没成功码，但确认今天已完成 —— 不是失败，也不是又签了一次
    described = {
      message: '今日已完成签到' + (already.basis ? '（' + already.basis + '）' : ''),
      success: true,
    };
  } else {
    described = describeResult(checkinResult, site);
  }

  const account = buildAccount(config, index, described, client);

  // 结果一行带全：状态描述 | 积分（含变化）| 剩余天数
  const changeSuffix =
    client.pointsChange && client.pointsChange !== UNKNOWN
      ? ' (' + client.pointsChange + ')'
      : '';
  plog(
    described.message +
      ' | 积分 ' + client.points + changeSuffix +
      ' | 剩余 ' + client.leftDays + ' 天'
  );

  // 自动兑换在签到之后，让当天新赚的积分也计入阈值。
  // 体检模式不兑换 —— 否则「验证」本身就会消耗掉积分。
  if (!opts.dryRun && config.exchangePlan && described.success) {
    const exchange = await autoExchange(client, config.exchangePlan, plog);
    account.exchangeResult = exchange.text;
    account.exchangeStatus = exchange.status;
  }

  return account;
}

/**
 * 跑完所有站点与账号。
 *
 * 单个账号异常不会中断整体 —— 失败会被记进结果里，其他账号照常继续。
 *
 * @param {object[]} sites loadSites 的结果
 * @param {{log: Function, dryRun?: boolean, debug?: boolean}} options
 * @returns {Promise<object[]>} 每个账号一条结果
 */
async function runCheckin(sites, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const accounts = [];

  for (const config of sites) {
    // 纯令牌鉴权的站点没有 Cookie，也要跑一次（用空 Cookie）
    const targets = config.cookies.length > 0 ? config.cookies : [''];

    for (let i = 0; i < targets.length; i += 1) {
      try {
        accounts.push(await processAccount(targets[i], i + 1, config, log, opts));
      } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        log('[' + config.site.label + ' 账号' + (i + 1) + '] 处理异常: ' + detail);
        accounts.push(
          buildAccount(config, i + 1, { message: '异常: ' + detail, success: false }, null)
        );
      }
    }
  }

  return accounts;
}

module.exports = {
  sleep,
  isDeterministicFailure,
  checkinWithRetry,
  describeResult,
  autoExchange,
  processAccount,
  runCheckin,
};

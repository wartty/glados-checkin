'use strict';

/**
 * 通知层。
 *
 * 设计原则：通知失败绝不中断签到主流程。签到本身才是目的，
 * 推送只是附带，任何推送异常都只记录日志。
 */

/** 把文本转义成 HTML，避免邮箱等字段里的特殊字符破坏推送排版。 */
function escapeHtml(input) {
  return String(input === undefined || input === null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 汇总各账号结果，生成推送正文（HTML）。
 *
 * @param {Array<{email: string, points: string, pointsChange: string, leftDays: string, message: string, success: boolean, exchangeResult?: string, exchangeInfo?: string}>} accounts
 * @param {{titlePrefix?: string, timestamp?: string}} [options]
 * @returns {{title: string, html: string, text: string}}
 */
function buildReport(accounts, options) {
  const opts = options || {};
  const successCount = accounts.filter((a) => a.success).length;
  const total = accounts.length;

  const title =
    (opts.titlePrefix || 'GLaDOS 签到') + ': 成功 ' + successCount + '/' + total;

  const blocks = accounts.map((a, index) => {
    const icon = a.success ? '✅' : '❌';
    const lines = [
      '<h3>' + icon + ' 账号 ' + (index + 1) + ' · ' + escapeHtml(a.email) + '</h3>',
      '<ul>',
      '<li><b>签到结果:</b> ' + escapeHtml(a.message) + '</li>',
      '<li><b>当前积分:</b> ' + escapeHtml(a.points) +
        (a.pointsChange && a.pointsChange !== '未知' ? ' (' + escapeHtml(a.pointsChange) + ')' : '') +
        '</li>',
      '<li><b>剩余天数:</b> ' + escapeHtml(a.leftDays) + ' 天</li>',
    ];

    if (a.exchangeResult) {
      lines.push('<li><b>自动兑换:</b> ' + escapeHtml(a.exchangeResult) + '</li>');
    }
    if (a.exchangeInfo) {
      lines.push('<li><b>兑换选项:</b><br>' + escapeHtml(a.exchangeInfo).replace(/\n/g, '<br>') + '</li>');
    }
    lines.push('</ul>');
    return lines.join('\n');
  });

  const html =
    blocks.join('\n<hr>\n') +
    '\n<hr>\n<p><small>时间: ' +
    escapeHtml(opts.timestamp || new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) +
    '</small></p>';

  // 纯文本版本，给 Telegram 或日志兜底
  const text = accounts
    .map((a, index) => {
      const icon = a.success ? '✅' : '❌';
      let s = icon + ' 账号 ' + (index + 1) + ' ' + a.email + '\n';
      s += '签到结果: ' + a.message + '\n';
      s += '当前积分: ' + a.points + '\n';
      s += '剩余天数: ' + a.leftDays + ' 天';
      if (a.exchangeResult) s += '\n自动兑换: ' + a.exchangeResult;
      return s;
    })
    .join('\n\n');

  return { title: title, html: html, text: text };
}

/**
 * PushPlus 微信推送。
 * @returns {Promise<boolean>}
 */
async function pushPlus(token, title, html, logger) {
  if (!token) return false;
  const log = logger || (() => {});
  try {
    const resp = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, title: title, content: html, template: 'html' }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await resp.json();
    const code = payload && payload.code;
    if (code !== undefined && code !== 0 && code !== 200) {
      log('⚠️ PushPlus 推送失败: ' + (payload.msg || 'code=' + code));
      return false;
    }
    log('✅ PushPlus 推送成功');
    return true;
  } catch (err) {
    log('⚠️ PushPlus 推送异常: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

/**
 * Telegram 推送（纯文本，避免 HTML 标签不被支持）。
 * @returns {Promise<boolean>}
 */
async function telegram(botToken, chatId, title, text, logger) {
  if (!botToken || !chatId) return false;
  const log = logger || (() => {});
  try {
    const url = 'https://api.telegram.org/bot' + botToken + '/sendMessage';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: title + '\n\n' + text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      log('⚠️ Telegram 推送失败: HTTP ' + resp.status);
      return false;
    }
    log('✅ Telegram 推送成功');
    return true;
  } catch (err) {
    log('⚠️ Telegram 推送异常: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

/**
 * 按配置分发通知。
 * @param {object} config
 * @param {{title: string, html: string, text: string}} report
 */
async function dispatch(config, report, logger) {
  const log = logger || (() => {});
  const tasks = [];
  if (config.pushPlusToken) {
    tasks.push(pushPlus(config.pushPlusToken, report.title, report.html, log));
  }
  if (config.telegramBotToken && config.telegramChatId) {
    tasks.push(telegram(config.telegramBotToken, config.telegramChatId, report.title, report.text, log));
  }
  if (tasks.length === 0) {
    log('ℹ️ 未配置推送渠道，跳过通知');
    return;
  }
  await Promise.allSettled(tasks);
}

module.exports = {
  escapeHtml,
  buildReport,
  pushPlus,
  telegram,
  dispatch,
};
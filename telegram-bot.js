require('dotenv').config();

const { ensureUser, createApiKey, getUser, getOrder, createOrder, settleOrder } = require('./usage-db');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
const CASHI_API_KEY = process.env.CASHI_API_KEY;
const CASHI_API_URL = 'https://cashi.id/api/create-order';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Add your BotFather token to .env.');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let updateOffset = 0;

async function telegram(method, payload = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API error (${response.status})`);
  return result.result;
}

async function telegramMultipart(method, form) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, { method: 'POST', body: form });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API error (${response.status})`);
  return result.result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function menuKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F4CA} API Dashboard', callback_data: 'dashboard' }, { text: '\u{1F4B3} Top up', callback_data: 'top_up' }],
    [{ text: '\u{1F9FE} Logs', callback_data: 'logs' }, { text: '\u{1F39F}\u{FE0F} Redeem Code', callback_data: 'redeem' }],
  ] };
}

function dashboardKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F511} Create new API key', callback_data: 'create_key' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function topUpKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F4B5} Rp10.000', callback_data: 'topup_10000' }, { text: '\u{1F4B5} Rp25.000', callback_data: 'topup_25000' }],
    [{ text: '\u{1F4B5} Rp50.000', callback_data: 'topup_50000' }, { text: '\u{1F4B5} Rp100.000', callback_data: 'topup_100000' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function welcomeMessage(firstName) {
  return [
    `\u{1F44B} <b>Welcome, ${escapeHtml(firstName || 'there')}!</b>`,
    '',
    '\u{1F680} Your API account is ready.',
    'Create and manage your OpenAI-compatible API keys below:',
  ].join('\n');
}

function statsMessage(telegramId) {
  const user = getUser(telegramId);
  if (!user) return 'No account found. Send /start first.';
  const key = user.apiKeys.find((entry) => entry.active !== false);
  const stats = user.stats;
  return [
    '\u{1F4CA} <b>API Dashboard</b>',
    '',
    `\u{1F511} API key: <code>${key ? escapeHtml(key.key) : 'none'}</code>`,
    `\u{1F4E1} Endpoint: <code>${escapeHtml(UPSTREAM_BASE_URL)}</code>`,
    `\u{1F4B0} Balance: <b>Rp${Number(user.balance || 0).toLocaleString('id-ID')}</b>`,
    '',
    `\u{1F4C8} Requests: <b>${stats.requests}</b>`,
    `\u{1F4E5} Input tokens: <b>${stats.inputTokens}</b>`,
    `\u{1F4E4} Output tokens: <b>${stats.outputTokens}</b>`,
    `\u{1F522} Total tokens: <b>${stats.totalTokens}</b>`,
    `\u{26A0}\u{FE0F} Errors: <b>${stats.errors}</b>`,
    '',
    'Use this key with an OpenAI-compatible client and base URL ending in <code>/v1</code>.',
  ].join('\n');
}

async function createCashiOrder(chatId, telegramId, amount) {
  if (!CASHI_API_KEY) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{26A0}\u{FE0F} Cashi payments are not configured yet. Add CASHI_API_KEY to .env.' });
    return;
  }
  const orderId = `TG-${telegramId}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const response = await fetch(CASHI_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': CASHI_API_KEY },
      body: JSON.stringify({ amount, order_id: orderId }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || `Cashi returned ${response.status}`);
    createOrder(telegramId, { orderId, amount, checkoutUrl: result.checkout_url, provider: result.provider || 'CASHI' });
    const caption = `\u{2705} <b>Payment QR ready</b>\n\nAmount: <b>Rp${amount.toLocaleString('id-ID')}</b>\nOrder: <code>${orderId}</code>\n\nScan this QR to pay. Your balance will update automatically after Cashi confirms payment.`;
    if (!result.qrUrl) throw new Error('Cashi did not return qrUrl for this payment');
    const qrUrl = String(result.qrUrl).trim();
    if (/^data:image\//i.test(qrUrl)) {
      const separator = qrUrl.indexOf(',');
      if (separator < 0) throw new Error('Invalid QR image returned by Cashi');
      const metadata = qrUrl.slice(5, separator);
      const imageData = qrUrl.slice(separator + 1).trim();
      const mimeType = metadata.split(';')[0] || 'image/png';
      const isBase64 = /;base64/i.test(metadata);
      if (!imageData) throw new Error('Empty QR image returned by Cashi');
      const imageBuffer = isBase64
        ? Buffer.from(imageData.replace(/\s/g, ''), 'base64')
        : Buffer.from(decodeURIComponent(imageData), 'utf8');
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
      form.append('photo', new Blob([imageBuffer], { type: mimeType }), 'cashi-qr.png');
      await telegramMultipart('sendPhoto', form);
    } else {
      await telegram('sendPhoto', { chat_id: chatId, photo: qrUrl, caption, parse_mode: 'HTML' });
    }
    await telegram('sendMessage', { chat_id: chatId, text: 'After payment, press Refresh status to check your payment. \u{1F4CA}', reply_markup: { inline_keyboard: [[{ text: '\u{1F504} Refresh status', callback_data: `status_${orderId}` }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] } });
  } catch (error) {
    console.error('[cashi]', error.message);
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not create the payment: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: menuKeyboard() });
  }
}

async function refreshCashiStatus(chatId, telegramId, orderId) {
  if (!CASHI_API_KEY) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{26A0}\u{FE0F} Cashi payments are not configured yet.' });
    return;
  }
  const order = getOrder(telegramId, orderId);
  if (!order) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{274C} Payment order not found.', reply_markup: menuKeyboard() });
    return;
  }
  try {
    const response = await fetch(`https://cashi.id/api/check-status/${encodeURIComponent(orderId)}`, { headers: { 'x-api-key': CASHI_API_KEY } });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || `Cashi returned ${response.status}`);
    const status = String(result.status || 'UNKNOWN').toUpperCase();
    if (status === 'SETTLED') settleOrder(orderId, result.amount);
    const updated = getUser(telegramId);
    const balance = Number(updated?.balance || 0).toLocaleString('id-ID');
    await telegram('sendMessage', {
      chat_id: chatId,
      text: status === 'SETTLED'
        ? `\u{2705} <b>Payment settled!</b>\n\nOrder: <code>${escapeHtml(orderId)}</code>\nBalance: <b>Rp${balance}</b>`
        : `\u{23F3} <b>Payment status: ${escapeHtml(status)}</b>\n\nOrder: <code>${escapeHtml(orderId)}</code>\nComplete the QR payment, then refresh again.`,
      parse_mode: 'HTML',
      reply_markup: status === 'SETTLED' ? menuKeyboard() : { inline_keyboard: [[{ text: '\u{1F504} Refresh status', callback_data: `status_${orderId}` }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] },
    });
  } catch (error) {
    console.error('[cashi status]', error.message);
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not check payment status: ${escapeHtml(error.message)}`, parse_mode: 'HTML' });
  }
}

async function sendDashboard(chatId, telegramId) {
  let user = getUser(telegramId);
  if (!user || !user.apiKeys.some((entry) => entry.active !== false)) {
    createApiKey(telegramId);
  }
  await telegram('sendMessage', { chat_id: chatId, text: statsMessage(telegramId), parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
}

async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const action = query.data;
  await telegram('answerCallbackQuery', { callback_query_id: query.id });

  if (action === 'dashboard') return sendDashboard(chatId, userId);
  if (action === 'menu') return telegram('sendMessage', { chat_id: chatId, text: welcomeMessage(query.from.first_name), parse_mode: 'HTML', reply_markup: menuKeyboard() });
  if (action === 'create_key') {
    const key = createApiKey(userId, { firstName: query.from.first_name, username: query.from.username });
    return telegram('sendMessage', { chat_id: chatId, text: `\u{1F389} <b>New API key created!</b>\n\n<code>${key}</code>\n\nKeep this key private.`, parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
  }

  if (action === 'top_up') {
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4B3} <b>Top up balance</b>\n\nChoose an amount to pay securely with Cashi.id:', parse_mode: 'HTML', reply_markup: topUpKeyboard() });
  }
  if (action.startsWith('topup_')) {
    const amount = Number(action.replace('topup_', ''));
    return createCashiOrder(chatId, userId, amount);
  }
  if (action.startsWith('status_')) {
    return refreshCashiStatus(chatId, userId, action.slice('status_'.length));
  }

  if (action === 'logs') {
    const user = getUser(userId);
    const logs = user?.logs || [];
    const lines = logs.slice(-10).reverse().map((entry) => `${escapeHtml(entry.at)} — ${escapeHtml(entry.endpoint)} (${entry.status})`);
    const text = lines.length ? `\u{1F9FE} <b>Recent API Logs</b>\n\n${lines.join('\n')}` : '\u{1F9FE} <b>Recent API Logs</b>\n\nNo API usage yet. \u{1F4ED}';
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: menuKeyboard() });
  }

  const replies = {
    redeem: '\u{1F39F}\u{FE0F} <b>Redeem Code</b>\n\nSend your redeem code in the chat. Code redemption can be connected to this JSON database next. \u{1F510}',
  };
  return telegram('sendMessage', { chat_id: chatId, text: replies[action] || 'Choose an option from the menu.', parse_mode: 'HTML', reply_markup: menuKeyboard() });
}

async function handleMessage(message) {
  if (!message.text) return;
  const user = message.from || {};
  const account = ensureUser(user.id || message.chat.id, { firstName: user.first_name, username: user.username });
  if (message.text === '/start' || message.text === '/menu') {
    if (!account.apiKeys.some((entry) => entry.active !== false)) {
      createApiKey(user.id || message.chat.id, { firstName: user.first_name, username: user.username });
    }
    await telegram('sendMessage', { chat_id: message.chat.id, text: welcomeMessage(user.first_name), parse_mode: 'HTML', reply_markup: menuKeyboard() });
    return;
  }
  await telegram('sendMessage', { chat_id: message.chat.id, text: 'Please use the menu below. \u{1F447}', reply_markup: menuKeyboard() });
}

async function poll() {
  try {
    const updates = await telegram('getUpdates', { offset: updateOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      if (update.callback_query) await handleCallbackQuery(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    }
  } catch (error) {
    console.error('[telegram]', error.message);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  setImmediate(poll);
}

telegram('deleteWebhook').then(() => telegram('getMe')).then((bot) => {
  console.log(`Telegram bot @${bot.username} is running.`);
  return poll();
}).catch((error) => {
  console.error('[telegram] startup failed:', error.message);
  process.exit(1);
});

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { adjustBalance, ensureUser, createApiKey, getAdminLogs, getAllUsers, getUser, getOrder, revokeApiKey, createOrder, settleOrder } = require('./usage-db');
const { DEFAULT_MODEL_PRICE, getModelFamily, getModelPrice, stripModelPrefix, tokenAllowance } = require('./pricing');
const { isAllModelsFree, readSettings, setAllModelsFree, setAnnouncement } = require('./admin-settings');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
const CASHI_API_KEY = process.env.CASHI_API_KEY;
const CASHI_API_URL = 'https://cashi.id/api/create-order';
const ADMIN_TELEGRAM_ID = '6957236291';
const pendingAdminActions = new Set();
const pendingAdminTopups = new Map();

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

function formatTokens(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function formatCost(value) {
  return `Rp${Number(value || 0).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function menuKeyboard(userId = '') {
  const rows = [
    [{ text: '\u{1F4CA} API Dashboard', callback_data: 'dashboard' }, { text: '\u{1F4B3} Top up', callback_data: 'top_up' }],
    [{ text: '\u{1F9FE} Logs', callback_data: 'logs' }, { text: '\u{1F39F}\u{FE0F} Redeem Code', callback_data: 'redeem' }],
  ];
  if (String(userId) === ADMIN_TELEGRAM_ID) rows.push([{ text: '\u{1F6E0}\u{FE0F} Admin Panel', callback_data: 'admin_panel' }]);
  return { inline_keyboard: rows };
}

function dashboardKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F9FE} Logs', callback_data: 'logs' }, { text: '\u{1F5D1}\u{FE0F} Revoke API Key', callback_data: 'revoke' }],
    [{ text: '\u{1F4B0} Model Price', callback_data: 'model_price' }, { text: '\u{1F4B3} Top Up Saldo', callback_data: 'top_up' }],
    [{ text: '\u{1F511} Create new API key', callback_data: 'create_key' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function modelKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F504} Resync Models', callback_data: 'model_resync' }],
    [{ text: '\u{1F519} Back to dashboard', callback_data: 'dashboard' }],
  ] };
}

function adminKeyboard() {
  return { inline_keyboard: [
    [{ text: isAllModelsFree() ? '\u{1F534} Disable Free Mode' : '\u{1F7E2} Make All Models Free', callback_data: 'admin_free_toggle' }],
    [{ text: '\u{1F4B3} Top Up User', callback_data: 'admin_topup' }],
    [{ text: '\u{1F4DC} Admin Logs', callback_data: 'admin_logs' }],
    [{ text: '\u{1F4E2} Send Announcement', callback_data: 'admin_announce' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function adminUsersKeyboard() {
  const users = getAllUsers();
  const rows = users.map((user) => [{
    text: `\u{1F464} ${user.firstName || user.username || user.telegramId} — Rp${Number(user.balance || 0).toLocaleString('id-ID')}`,
    callback_data: `admin_topup_user_${user.telegramId}`,
  }]);
  rows.push([{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { inline_keyboard: rows };
}

function adminTopupAmounts(userId) {
  return { inline_keyboard: [
    [{ text: 'Rp10.000', callback_data: `admin_topup_amount_${userId}_10000` }, { text: 'Rp50.000', callback_data: `admin_topup_amount_${userId}_50000` }],
    [{ text: 'Rp100.000', callback_data: `admin_topup_amount_${userId}_100000` }, { text: 'Rp500.000', callback_data: `admin_topup_amount_${userId}_500000` }],
    [{ text: '\u{270F}\u{FE0F} Custom amount', callback_data: `admin_topup_custom_${userId}` }],
    [{ text: '\u{1F519} Back to users', callback_data: 'admin_topup' }],
  ] };
}

function adminPanelMessage() {
  const settings = readSettings();
  return [
    '\u{1F6E0}\u{FE0F} <b>Admin Panel</b>',
    '',
    `\u{1F4B8} All models free: <b>${settings.allModelsFree ? 'ON' : 'OFF'}</b>`,
    `\u{1F4E2} Last announcement: <b>${settings.announcement ? escapeHtml(settings.announcement.slice(0, 80)) : 'None'}</b>`,
    '',
    'Free mode still requires every request to use a valid user API key.',
  ].join('\n');
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
  const activeKeys = user.apiKeys.filter((entry) => entry.active !== false);
  const stats = user.stats;
  const keyList = activeKeys.length
    ? activeKeys.map((entry, index) => `\u{1F511} Key ${index + 1}: <code>${escapeHtml(entry.key)}</code>`).join('\n')
    : '\u{1F511} API keys: none';
  return [
    '\u{1F4CA} <b>API Dashboard</b>',
    '',
    keyList,
    `\u{1F4E1} Endpoint: <code>${escapeHtml(UPSTREAM_BASE_URL)}</code>`,
    `\u{1F4B0} Balance: <b>Rp${Number(user.balance || 0).toLocaleString('id-ID')}</b>`,
    '',
    `\u{1F4C8} Requests: <b>${stats.requests}</b>`,
    `\u{1F4E5} Input tokens: <b>${stats.inputTokens}</b>`,
    `\u{1F4E4} Output tokens: <b>${stats.outputTokens}</b>`,
    `\u{1F522} Total tokens: <b>${stats.totalTokens}</b>`,
    `\u{1F4B8} Estimated spent: <b>Rp${Number(stats.spent || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}</b>`,
    `\u{26A0}\u{FE0F} Errors: <b>${stats.errors}</b>`,
    '',
    'Use this key with an OpenAI-compatible client and base URL ending in <code>/v1</code>.',
  ].join('\n');
}

async function modelPriceMessage() {
  const response = await fetch(`${UPSTREAM_BASE_URL}/models`, {
    headers: UPSTREAM_API_KEY ? { Authorization: `Bearer ${UPSTREAM_API_KEY}` } : {},
  });
  const result = await response.json();
  if (!response.ok || !Array.isArray(result.data)) throw new Error(result.error?.message || `Upstream returned ${response.status}`);
  const aliases = {};
  for (const model of result.data.map((entry) => entry.id).filter(Boolean)) {
    const displayName = stripModelPrefix(model);
    // Prefer the 1/ upstream route when both 1/ and cx/ expose the same name.
    if (!aliases[displayName] || model.startsWith('1/')) aliases[displayName] = model;
  }
  const models = Object.keys(aliases).filter((model) => getModelFamily(model));
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'models.json'), JSON.stringify({ syncedAt: new Date().toISOString(), models, aliases }, null, 2), 'utf8');
  const families = ['Groq', 'Qwen', 'ChatGPT', 'Hy', 'DeepSeek', 'GLM', 'Kimi', 'Gemini', 'MiniMax'];
  const sections = families.map((family) => {
    const familyModels = models.filter((model) => getModelFamily(model) === family);
    if (!familyModels.length) return '';
    const lines = familyModels.map((model) => {
      const price = getModelPrice(model);
      if (price === 0) return `• <code>${escapeHtml(model)}</code> — Gratis\n  ↳ Saldo Rp10rb ≈ Unlimited (Gratis)`;
      const appliedPrice = price ?? DEFAULT_MODEL_PRICE;
      const label = price === null ? ' (default)' : '';
      const allowance = tokenAllowance(appliedPrice, 10000);
      return `• <code>${escapeHtml(model)}</code> — Rp${appliedPrice.toLocaleString('id-ID')} / 1M token${label}\n  ↳ Saldo Rp10rb ≈ ±${(allowance / 1_000_000).toFixed(1)} juta token`;
    });
    return `<b>${family} Family</b>\n${lines.join('\n')}`;
  }).filter(Boolean);
  return `\u{1F4B0} <b>Model Price</b>\n\n${sections.length ? sections.join('\n\n') : 'No supported models returned by upstream.'}`;
}

function revokeKeyboard(user) {
  const activeKeys = (user?.apiKeys || []).filter((entry) => entry.active !== false);
  const rows = activeKeys.map((entry, index) => [{ text: `\u{1F5D1}\u{FE0F} Revoke key ${index + 1}`, callback_data: `revoke_${index}` }]);
  rows.push([{ text: '\u{1F519} Back to dashboard', callback_data: 'dashboard' }]);
  return { inline_keyboard: rows };
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

async function sendDashboard(chatId, telegramId, notice = '') {
  let user = getUser(telegramId);
  if (!user || !user.apiKeys.some((entry) => entry.active !== false)) {
    createApiKey(telegramId);
  }
  const text = notice ? `${notice}\n\n${statsMessage(telegramId)}` : statsMessage(telegramId);
  await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
}

async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const action = query.data;
  await telegram('answerCallbackQuery', { callback_query_id: query.id });

  if (action === 'dashboard') return sendDashboard(chatId, userId);
  if (action === 'menu') return telegram('sendMessage', { chat_id: chatId, text: welcomeMessage(query.from.first_name), parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
  if (action === 'admin_panel') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    return telegram('sendMessage', { chat_id: chatId, text: adminPanelMessage(), parse_mode: 'HTML', reply_markup: adminKeyboard() });
  }
  if (action === 'admin_free_toggle') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const enabled = !isAllModelsFree();
    setAllModelsFree(enabled);
    return telegram('sendMessage', { chat_id: chatId, text: `${enabled ? '\u{2705} All models are now free.' : '\u{2705} Normal model pricing restored.'}\n\n${adminPanelMessage()}`, parse_mode: 'HTML', reply_markup: adminKeyboard() });
  }
  if (action === 'admin_topup') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4B3} <b>Top Up User</b>\n\nChoose a user:', parse_mode: 'HTML', reply_markup: adminUsersKeyboard() });
  }
  if (action === 'admin_logs') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const logs = getAdminLogs(30);
    const lines = logs.map((entry) => {
      const model = entry.model ? ` model=${entry.model}` : '';
      const user = entry.userId ? ` user=${entry.userId}` : ' anonymous';
      const tokens = ` in=${Number(entry.inputTokens || 0)} out=${Number(entry.outputTokens || 0)} total=${Number(entry.totalTokens || 0)}`;
      const cost = ` cost=Rp${Number(entry.cost || 0).toLocaleString('id-ID', { maximumFractionDigits: 4 })}`;
      const balance = entry.balanceAfter === undefined ? '' : ` balance=Rp${Number(entry.balanceAfter || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
      const rate = entry.pricePerMillion ? ` rate=Rp${Number(entry.pricePerMillion).toLocaleString('id-ID')}/1M` : '';
      return `${entry.at} ${entry.method} ${entry.path} → ${entry.status}${model}${user}${tokens}${rate}${cost}${balance}`;
    });
    const logText = lines.join('\n').slice(-3500);
    const text = lines.length
      ? `\u{1F4DC} <b>Admin Request Logs</b>\n\n<code>${escapeHtml(logText)}</code>`
      : '\u{1F4DC} <b>Admin Request Logs</b>\n\nNo requests recorded yet.';
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: adminKeyboard() });
  }
  if (action.startsWith('admin_topup_user_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const targetId = action.slice('admin_topup_user_'.length);
    const target = getUser(targetId);
    if (!target) return telegram('sendMessage', { chat_id: chatId, text: 'User not found.', reply_markup: adminUsersKeyboard() });
    return telegram('sendMessage', { chat_id: chatId, text: `\u{1F4B3} Top up <b>${escapeHtml(target.firstName || target.username || target.telegramId)}</b>\n\nCurrent balance: <b>Rp${Number(target.balance || 0).toLocaleString('id-ID')}</b>\n\nChoose amount:`, parse_mode: 'HTML', reply_markup: adminTopupAmounts(targetId) });
  }
  if (action.startsWith('admin_topup_amount_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const parts = action.split('_');
    const targetId = parts[3];
    const amount = Number(parts[4]);
    const newBalance = adjustBalance(targetId, amount);
    if (newBalance === null) return telegram('sendMessage', { chat_id: chatId, text: 'Top up failed: user or amount is invalid.', reply_markup: adminUsersKeyboard() });
    await telegram('sendMessage', { chat_id: targetId, text: `\u{1F389} <b>Balance added!</b>\n\nTop up: <b>Rp${amount.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML' }).catch(() => {});
    return telegram('sendMessage', { chat_id: chatId, text: `\u{2705} Balance updated.\n\nUser: <code>${escapeHtml(targetId)}</code>\nAdded: <b>Rp${amount.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML', reply_markup: adminKeyboard() });
  }
  if (action.startsWith('admin_topup_custom_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const targetId = action.slice('admin_topup_custom_'.length);
    if (!getUser(targetId)) return telegram('sendMessage', { chat_id: chatId, text: 'User not found.', reply_markup: adminUsersKeyboard() });
    pendingAdminTopups.set(String(userId), targetId);
    return telegram('sendMessage', { chat_id: chatId, text: '\u{270F}\u{FE0F} Send custom balance adjustment.\n\nExamples:\n<code>+50000</code> add Rp50.000\n<code>-10000</code> take Rp10.000', parse_mode: 'HTML' });
  }
  if (action === 'admin_announce') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    pendingAdminActions.add(String(userId));
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4E2} Send the announcement text now. It will be delivered to every registered user.' });
  }
  if (action === 'create_key') {
    const key = createApiKey(userId, { firstName: query.from.first_name, username: query.from.username });
    return sendDashboard(chatId, userId, `\u{1F389} <b>New API key created!</b>\n\n<code>${key}</code>\n\nKeep this key private.`);
  }

  if (action === 'revoke') {
    const user = getUser(userId);
    const activeKeys = (user?.apiKeys || []).filter((entry) => entry.active !== false);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: activeKeys.length ? '\u{1F5D1}\u{FE0F} <b>Revoke API Key</b>\n\nChoose the key you want to revoke. This cannot be undone.' : 'No active API keys to revoke.',
      parse_mode: 'HTML',
      reply_markup: revokeKeyboard(user),
    });
  }
  if (action.startsWith('revoke_')) {
    const revokedKey = revokeApiKey(userId, action.slice('revoke_'.length));
    if (!revokedKey) return telegram('sendMessage', { chat_id: chatId, text: '\u{274C} API key not found or already revoked.', reply_markup: dashboardKeyboard() });
    return sendDashboard(chatId, userId, '\u{2705} API key revoked successfully. It can no longer access the API.');
  }
  if (action === 'model_price') {
    try {
      const text = await modelPriceMessage();
      return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not load model prices: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    }
  }
  if (action === 'model_resync') {
    try {
      const text = await modelPriceMessage();
      return telegram('sendMessage', { chat_id: chatId, text: `\u{2705} Models resynced from upstream.\n\n${text}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Model resync failed: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    }
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
    const lines = logs.slice(-10).reverse().map((entry, index) => {
      const input = Number(entry.inputTokens || 0);
      const output = Number(entry.outputTokens || 0);
      const total = input + output;
      return [
        `<b>#${index + 1} ${entry.status >= 400 ? '❌' : '✅'} ${escapeHtml(entry.endpoint)}</b>`,
        `🕒 ${escapeHtml(entry.at)}`,
        `🤖 Model: <code>${escapeHtml(entry.model || 'unknown')}</code>`,
        `📥 Input: <b>${formatTokens(input)}</b>  •  📤 Output: <b>${formatTokens(output)}</b>`,
        `🔢 Total: <b>${formatTokens(total)}</b>  •  💰 Tarif: <b>Rp${formatTokens(entry.pricePerMillion)}/1M</b>`,
        `💳 Biaya: <b>${formatCost(entry.cost)}</b>`,
      ].join('\n');
    });
    const text = lines.length ? `\u{1F9FE} <b>Recent API Logs</b>\n\n${lines.join('\n\n')}` : '\u{1F9FE} <b>Recent API Logs</b>\n\nNo API usage yet. \u{1F4ED}';
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
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
  const userId = String(user.id || message.chat.id);
  if (userId === ADMIN_TELEGRAM_ID && pendingAdminTopups.has(userId) && !message.text.startsWith('/')) {
    const targetId = pendingAdminTopups.get(userId);
    pendingAdminTopups.delete(userId);
    const normalized = message.text.replace(/[.\sRp]/gi, '');
    const delta = Number(normalized);
    if (!Number.isFinite(delta) || delta === 0) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Invalid amount. Use +50000 or -10000.', reply_markup: adminKeyboard() });
      return;
    }
    const target = getUser(targetId);
    const newBalance = adjustBalance(targetId, delta);
    if (!target || newBalance === null) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'User or amount is invalid.', reply_markup: adminKeyboard() });
      return;
    }
    const direction = delta > 0 ? 'added' : 'deducted';
    const absolute = Math.abs(delta);
    await telegram('sendMessage', { chat_id: targetId, text: `\u{1F4B0} Balance ${direction}: <b>Rp${absolute.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML' }).catch(() => {});
    await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{2705} Balance ${direction}.\nUser: <code>${escapeHtml(targetId)}</code>\nAmount: <b>Rp${absolute.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML', reply_markup: adminKeyboard() });
    return;
  }
  if (userId === ADMIN_TELEGRAM_ID && pendingAdminActions.has(userId) && !message.text.startsWith('/')) {
    pendingAdminActions.delete(userId);
    const announcement = message.text.trim();
    setAnnouncement(announcement);
    let delivered = 0;
    for (const recipient of getAllUsers()) {
      try {
        await telegram('sendMessage', { chat_id: recipient.telegramId, text: `\u{1F4E2} <b>Announcement</b>\n\n${escapeHtml(announcement)}`, parse_mode: 'HTML' });
        delivered += 1;
      } catch (error) {
        console.error('[announcement]', recipient.telegramId, error.message);
      }
    }
    await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{2705} Announcement sent to ${delivered} user(s).`, reply_markup: adminKeyboard() });
    return;
  }
  if (message.text === '/start' || message.text === '/menu') {
    if (!account.apiKeys.some((entry) => entry.active !== false)) {
      createApiKey(user.id || message.chat.id, { firstName: user.first_name, username: user.username });
    }
    await telegram('sendMessage', { chat_id: message.chat.id, text: welcomeMessage(user.first_name), parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
    return;
  }
  if (message.text === '/admin') {
    if (userId !== ADMIN_TELEGRAM_ID) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Access denied.' });
      return;
    }
    await telegram('sendMessage', { chat_id: message.chat.id, text: adminPanelMessage(), parse_mode: 'HTML', reply_markup: adminKeyboard() });
    return;
  }
  if (message.text === '/model' || message.text === '/models') {
    try {
      const text = await modelPriceMessage();
      await telegram('sendMessage', { chat_id: message.chat.id, text, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Could not sync models: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: menuKeyboard() });
    }
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

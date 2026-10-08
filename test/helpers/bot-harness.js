// Drives telegram-bot.js through scripted updates with a stubbed fetch: Telegram, Cashi and the
// upstream are NEVER contacted (any other network call throws). Prints the transcript as JSON.
// Used by test/bot-ui.test.js in a child process with an isolated temporary data directory.
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN = process.env.ADMIN_TELEGRAM_ID;
const USER = '700001';
const transcript = [];
const cashiOrders = [];
let messageId = 1000;
let updateId = 1;
let stepIndex = 0;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const person = (id, name) => ({ id: Number(id), first_name: name, username: `${name.toLowerCase()}_user`, language_code: 'id' });
const message = (id, text) => ({ message_id: ++messageId, chat: { id: Number(id), type: 'private' }, from: person(id, id === ADMIN ? 'Admin' : 'Budi'), text });
const press = (id, data) => ({
  id: `cb${updateId}`,
  from: person(id, id === ADMIN ? 'Admin' : 'Budi'),
  message: { message_id: ++messageId, chat: { id: Number(id), type: 'private' }, text: '' },
  data,
});

function lastStatusButton() {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const rows = transcript[i].payload?.reply_markup?.inline_keyboard || [];
    const button = rows.flat().find((item) => String(item.callback_data || '').startsWith('status_KR-'));
    if (button) return button.callback_data;
  }
  throw new Error('no refresh status button was sent');
}

const STEPS = [
  () => ({ message: message(USER, '/start') }),
  () => ({ callback_query: press(USER, 'lang_id') }),
  () => ({ callback_query: press(USER, 'credits') }),
  () => ({ callback_query: press(USER, 'cr_models') }),
  () => ({ callback_query: press(USER, 'cr_hist') }),
  () => ({ callback_query: press(USER, 'cr_ul') }),
  () => ({ callback_query: press(USER, 'top_up') }),
  () => ({ callback_query: press(USER, 'crbuy_kredit-10m') }),
  () => ({ callback_query: press(USER, lastStatusButton()) }),
  () => ({ callback_query: press(USER, 'credits') }),
  () => ({ callback_query: press(USER, 'cr_hist') }),
  () => ({ callback_query: press(USER, 'admin_cr') }),
  () => ({ message: message(ADMIN, '/start') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_rates') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_routing') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_limits') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_ul') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_orders') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_cmd') }),
  () => ({ message: message(ADMIN, 'tarif glm-5v-turbo 1.5\nroute cbcn deepseek-v4-flash deepseek-v4.1-flash\nunlimited harga 1 5000\nkredit 700001 +1000000 bonus uji\ntarif glm-5v-turbo 0') }),
  () => ({ callback_query: press(ADMIN, 'admin_cr_audit') }),
  () => ({ callback_query: press(ADMIN, `admin_topup_user_${USER}`) }),
  () => ({ callback_query: press(ADMIN, `admin_cr_user_${USER}`) }),
  () => ({ message: message(ADMIN, '-500000 koreksi') }),
  () => ({ callback_query: press(ADMIN, 'admin_panel') }),
  () => ({ callback_query: press(USER, 'dashboard') }),
  () => ({ message: message(USER, '/kredit') }),
  () => ({ callback_query: press(USER, 'cr_models') }),
];

function finish(error) {
  process.stdout.write(`${JSON.stringify({ transcript, cashiOrders, error: error ? String(error.stack || error) : null })}\n`);
  process.exit(error ? 1 : 0);
}

async function nextUpdates() {
  if (stepIndex >= STEPS.length) {
    setTimeout(() => finish(), 50);
    return new Promise(() => {}); // never answers: the process exits
  }
  const step = stepIndex;
  stepIndex += 1;
  transcript.push({ step });
  return [{ update_id: updateId++, ...STEPS[step]() }];
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('https://api.telegram.org/')) {
    const method = href.split('/').pop();
    const payload = typeof options.body === 'string' ? JSON.parse(options.body) : { multipart: true };
    if (method === 'getUpdates') return json({ ok: true, result: await nextUpdates() });
    if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'test_bot' } });
    transcript.push({ method, payload });
    if (method === 'sendMessage' || method === 'sendPhoto') return json({ ok: true, result: { message_id: ++messageId, chat: { id: payload.chat_id } } });
    return json({ ok: true, result: true });
  }
  if (href === 'https://cashi.id/api/create-order') {
    const body = JSON.parse(options.body);
    cashiOrders.push(body);
    return json({ success: true, qrUrl: 'https://example.invalid/qr.png', checkout_url: 'https://example.invalid/pay' });
  }
  if (href.startsWith('https://cashi.id/api/check-status/')) {
    const orderId = decodeURIComponent(href.split('/').pop());
    const order = cashiOrders.find((entry) => entry.order_id === orderId);
    return json({ success: true, status: 'SETTLED', amount: order ? order.amount : 0 });
  }
  throw new Error(`unexpected network call in the bot test: ${href}`);
};

process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('bot harness timed out')), 30_000).unref();
require(path.join(ROOT, 'telegram-bot.js'));

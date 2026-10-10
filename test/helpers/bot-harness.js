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
    const button = rows.flat().find((item) => /^status_(KR|UL)-/.test(item.callback_data || ''));
    if (button) return button.callback_data;
  }
  throw new Error('no refresh status button was sent');
}

function lastButton(predicate) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const buttons = transcript[index].payload?.reply_markup?.inline_keyboard?.flat() || [];
    const button = buttons.find(predicate);
    if (button) return button.callback_data;
  }
  throw new Error('expected UI button was not found');
}

const uiStep = (label, build) => Object.assign(build, { label });
const modelButton = (name) => lastButton(button => /^admin_cr_rate_[a-f0-9]{12}$/.test(button.callback_data || '') && button.text.endsWith(` ${name}`));
const textButton = (label) => lastButton(button => button.text === label);
let staleMultiplierButton;

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
  () => ({ callback_query: press(ADMIN, 'admin_payments_toggle') }),
  () => ({ callback_query: press(USER, 'top_up') }),
  () => ({ callback_query: press(ADMIN, 'top_up') }),
  uiStep('multiplier_list', () => ({ callback_query: press(ADMIN, 'admin_cr_rates') })),
  uiStep('multiplier_denied', () => ({ callback_query: press(USER, modelButton('glm-5v-turbo')) })),
  uiStep('multiplier_detail', () => ({ callback_query: press(ADMIN, modelButton('glm-5v-turbo')) })),
  uiStep('multiplier_preset', () => {
    staleMultiplierButton = textButton('\u00d72');
    return { callback_query: press(ADMIN, staleMultiplierButton) };
  }),
  uiStep('multiplier_stale', () => ({ callback_query: press(ADMIN, staleMultiplierButton) })),
  uiStep('multiplier_custom', () => ({ callback_query: press(ADMIN, textButton('\u2328\ufe0f Masukkan nilai sendiri')) })),
  uiStep('multiplier_zero', () => ({ message: message(ADMIN, '0') })),
  uiStep('multiplier_large', () => ({ message: message(ADMIN, '1001') })),
  uiStep('multiplier_precision', () => ({ message: message(ADMIN, '1,23456') })),
  uiStep('multiplier_saved', () => ({ message: message(ADMIN, '1,875') })),
  uiStep('multiplier_search', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_search') })),
  uiStep('multiplier_filtered', () => ({ message: message(ADMIN, 'deepseek-v4-flash') })),
  uiStep('multiplier_routed', () => ({ callback_query: press(ADMIN, modelButton('deepseek-v4-flash')) })),
  uiStep('multiplier_routed_saved', () => ({ callback_query: press(ADMIN, textButton('\u00d72,5')) })),
  uiStep('multiplier_filter_back', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_back') })),
  uiStep('multiplier_search_again', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_search') })),
  uiStep('multiplier_empty', () => ({ message: message(ADMIN, 'does-not-exist') })),
  uiStep('multiplier_all', () => ({ callback_query: press(ADMIN, 'admin_cr_rates') })),
  uiStep('multiplier_page_next', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_page_1') })),
  uiStep('multiplier_page_back', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_page_0') })),
  uiStep('multiplier_alias', () => ({ callback_query: press(ADMIN, modelButton('claude')) })),
  uiStep('multiplier_cancel_list', () => ({ callback_query: press(ADMIN, 'admin_cr_rates') })),
  uiStep('multiplier_cancel_detail', () => ({ callback_query: press(ADMIN, modelButton('glm-5v-turbo')) })),
  uiStep('multiplier_cancel_prompt', () => ({ callback_query: press(ADMIN, textButton('\u2328\ufe0f Masukkan nilai sendiri')) })),
  uiStep('multiplier_cancelled', () => ({ callback_query: press(ADMIN, textButton('\u{1F519} Batal')) })),
  uiStep('multiplier_cancel_text', () => ({ message: message(ADMIN, '7') })),
  uiStep('multiplier_split_console', () => ({ callback_query: press(ADMIN, 'admin_cr_cmd') })),
  uiStep('multiplier_split_setup', () => ({ message: message(ADMIN, 'tarif glm-5v-turbo input 0.25') })),
  uiStep('multiplier_split_list', () => ({ callback_query: press(ADMIN, 'admin_cr_rates') })),
  uiStep('multiplier_split_detail', () => ({ callback_query: press(ADMIN, modelButton('glm-5v-turbo')) })),
  uiStep('multiplier_split_saved', () => ({ callback_query: press(ADMIN, textButton('\u00d71,5')) })),
  uiStep('multiplier_long_search', () => ({ callback_query: press(ADMIN, 'admin_cr_rates_search') })),
  uiStep('multiplier_long_results', () => ({ message: message(ADMIN, 'glm-long-model') })),
  uiStep('multiplier_long_detail', () => ({ callback_query: press(ADMIN, modelButton(`glm-${'long-model-'.repeat(7)}test`)) })),
  uiStep('multiplier_long_saved', () => ({ callback_query: press(ADMIN, textButton('\u00d71,25')) })),
  uiStep('multiplier_slash_prompt', () => ({ callback_query: press(ADMIN, textButton('\u2328\ufe0f Masukkan nilai sendiri')) })),
  uiStep('multiplier_slash_cancel', () => ({ message: message(ADMIN, '/start') })),
  uiStep('multiplier_slash_text', () => ({ message: message(ADMIN, '9') })),
  uiStep('china_setup', () => {
    const config = require(path.join(ROOT, 'credit-config'));
    const { buildChinaUnlimitedPlan } = require(path.join(ROOT, 'scripts', 'configure-china-unlimited'));
    for (const change of buildChinaUnlimitedPlan(config.getCreditCatalog()).changes) config.updateCreditConfig(change, ADMIN);
    return { callback_query: press(ADMIN, 'admin_payments_toggle') };
  }),
  uiStep('china_shop', () => ({ callback_query: press(USER, 'cr_ul') })),
  uiStep('china_buy_day', () => ({ callback_query: press(USER, 'ulbuy_72') })),
  uiStep('china_paid_day', () => ({ callback_query: press(USER, lastStatusButton()) })),
  uiStep('china_buy_week', () => ({ callback_query: press(USER, 'ulbuy_168') })),
  uiStep('china_paid_week', () => ({ callback_query: press(USER, lastStatusButton()) })),
  uiStep('china_active', () => ({ callback_query: press(USER, 'cr_ul') })),
  uiStep('china_history', () => ({ callback_query: press(USER, 'cr_hist') })),
  uiStep('rupiah_buy', () => ({ callback_query: press(USER, 'topup_10000') })),
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
  transcript.push({ step, label: STEPS[step].label });
  return [{ update_id: updateId++, ...STEPS[step]() }];
}

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('https://api.telegram.org/')) {
    const method = href.split('/').pop();
    const payload = typeof options.body === 'string' ? JSON.parse(options.body) : { multipart: true };
    if (method === 'getUpdates') return json({ ok: true, result: await nextUpdates() });
    if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'test_bot' } });
    if (method === 'getChatMember') return json({ ok: true, result: { status: payload.user_id === 1 ? 'administrator' : 'member' } });
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
    if (process.env.CASHI_TEST_STATUS_MODE === 'without_amount') return json({ success: true, status: 'SETTLED', provider_tx_id: null, is_final: true });
    return json({ success: true, status: 'SETTLED', amount: order ? order.amount : 0 });
  }
  if (href.startsWith('https://cashi.id/api/checkout/')) {
    const orderId = decodeURIComponent(href.split('/').pop());
    const order = cashiOrders.find((entry) => entry.order_id === orderId);
    return json({ success: true, data: { order_id: orderId, status: 'SETTLED', amount: String(order?.amount || 0), total_amount: order?.amount || 0 } });
  }
  throw new Error(`unexpected network call in the bot test: ${href}`);
};

process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('bot harness timed out')), 30_000).unref();
require(path.join(ROOT, 'telegram-bot.js'));

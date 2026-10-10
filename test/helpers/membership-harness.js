'use strict';

// Runs the real polling/dispatch loop against stubbed Telegram only. All data
// paths and cwd are supplied by the parent test's isolated temporary directory.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const db = require(path.join(ROOT, 'usage-db'));
const settings = require(path.join(ROOT, 'admin-settings'));
const USER = '710001';
const REFERRER = '710002';
const ADMIN = process.env.ADMIN_TELEGRAM_ID;
settings.setReferralSettings({ enabled: true, rewardTokens: 1000000, maxRewardsPerUser: 0 });
const referralCode = db.getReferralInfo(REFERRER).code;
const transcript = [];
const snapshots = {};
let stepIndex = -1;
let messageId = 100;
let verificationButton;
let adminSendButton;
let cancelledSendButton;
let broadcastDone = false;
const broadcastAttempts = [];

const person = id => ({ id: Number(id), first_name: 'Test', username: 'test_user' });
const message = (text, id = USER, type = 'private') => ({ message: {
  message_id: ++messageId, from: person(id), chat: { id: type === 'private' ? Number(id) : -100123, type }, text,
} });
const press = (data, id = USER) => ({ callback_query: {
  id: `query-${messageId++}`, from: person(id), data,
  message: { message_id: ++messageId, from: { id: 1, is_bot: true }, chat: { id: Number(id), type: 'private' }, text: '' },
} });
const steps = [
  { label: 'start_blocked', member: { status: 'left' }, build: () => message(`/start ${referralCode}`) },
  ...['create_key', 'dashboard', 'credits', 'crbuy_kredit-10m', 'ulbuy_24', 'lang_id', 'poll_vote_1_0', 'ticket']
    .map(action => ({ label: `blocked_${action}`, member: { status: 'left' }, build: () => press(action) })),
  ...['/dashboard', '/menu', '/redeem RDM-ABCDEF-ABCDEF', 'RDM-ABCDEF-ABCDEF']
    .map((text, i) => ({ label: `blocked_command_${i}`, member: { status: 'left' }, build: () => message(text) })),
  { label: 'blocked_media', member: { status: 'left' }, build: () => {
    const update = message(undefined);
    update.message.photo = [{ file_id: 'test-photo', width: 1, height: 1 }];
    return update;
  } },
  { label: 'blocked_admin', member: { status: 'left' }, build: () => message('/admin', ADMIN) },
  { label: 'verify_left', member: { status: 'left' }, build: () => press(verificationButton) },
  { label: 'verify_kicked', member: { status: 'kicked' }, build: () => press(verificationButton) },
  { label: 'verify_restricted_no', member: { status: 'restricted', is_member: false }, build: () => press(verificationButton) },
  { label: 'verify_unknown', member: { status: 'unexpected' }, build: () => press(verificationButton) },
  { label: 'verify_error', error: 'Bad Request: member list is inaccessible', build: () => press(verificationButton) },
  { label: 'verify_timeout', timeout: true, build: () => press(verificationButton) },
  { label: 'verify_only_hub', member: { status: 'member' }, members: { '@galaxy_testi': { status: 'left' } }, build: () => press(verificationButton) },
  { label: 'verify_only_testi', member: { status: 'member' }, members: { '@galaxy_hub_api': { status: 'left' } }, build: () => press(verificationButton) },
  { label: 'verify_testi_error', member: { status: 'member' }, error: 'Bad Request: chat not found', errorGroup: '@galaxy_testi', build: () => press(verificationButton) },
  { label: 'verify_ok', member: { status: 'member' }, build: () => press(verificationButton) },
  { label: 'language', member: { status: 'member' }, build: () => press('lang_id') },
  { label: 'verify_repeat', member: { status: 'member' }, build: () => press(verificationButton) },
  { label: 'left_again', member: { status: 'left' }, build: () => press('create_key') },
  { label: 'left_testi_again', member: { status: 'member' }, members: { '@galaxy_testi': { status: 'left' } }, build: () => press('create_key') },
  { label: 'rejoined', member: { status: 'member' }, build: () => press('group_verify') },
  { label: 'create_key_allowed', member: { status: 'member' }, build: () => press('create_key') },
  ...['member', 'administrator', 'creator', 'restricted'].map((status, i) => ({
    label: `allowed_${status}`, member: { status, is_member: true }, build: () => message('/start', String(710010 + i)),
  })),
  { label: 'group_ignored', member: { status: 'member' }, build: () => message('/start', '710020', 'supergroup') },
  { label: 'inline_ignored', member: { status: 'member' }, build: () => ({ callback_query: { from: person(USER), id: 'inline-query', inline_message_id: 'inline', data: 'create_key' } }) },
  { label: 'admin_start', member: { status: 'member' }, build: () => message('/admin', ADMIN) },
  { label: 'admin_groups_denied', member: { status: 'member' }, build: () => press('admin_groups') },
  { label: 'admin_groups_open', member: { status: 'member' }, build: () => press('admin_groups', ADMIN) },
  { label: 'admin_prepare_cancel', member: { status: 'member' }, build: () => press('admin_group_prepare', ADMIN) },
  { label: 'admin_cancel', member: { status: 'member' }, build: () => {
    cancelledSendButton = adminSendButton;
    return press('admin_groups', ADMIN);
  } },
  { label: 'admin_cancelled_send', member: { status: 'member' }, build: () => press(cancelledSendButton, ADMIN) },
  { label: 'admin_prepare_send', member: { status: 'member' }, build: () => press('admin_group_prepare', ADMIN) },
  { label: 'admin_send_denied', member: { status: 'member' }, build: () => press(adminSendButton) },
  { label: 'admin_send', member: { status: 'member' }, build: () => press(adminSendButton, ADMIN) },
  { label: 'admin_send_duplicate', member: { status: 'member' }, build: () => press(adminSendButton, ADMIN) },
];

function snapshot() {
  if (stepIndex < 0 || stepIndex >= steps.length) return;
  const ids = [USER, ADMIN, '710010', '710011', '710012', '710013', '710020'];
  snapshots[steps[stepIndex].label] = {
    users: Object.fromEntries(ids.map(id => {
      const user = db.getUser(id);
      return [id, user ? { keys: user.apiKeys.length, language: user.language, referredBy: user.referredBy?.code } : null];
    })),
    bonus: db.getUser(REFERRER)?.bonusTokens || 0,
    broadcastAttempts: broadcastAttempts.length,
  };
}

function finish(error) {
  snapshot();
  console.log(JSON.stringify({ transcript, snapshots, referralCode, broadcastAttempts, broadcastDone, recipients: db.getAllUsers().map(user => user.telegramId), error: error?.message || null }));
  process.exit(error ? 1 : 0);
}
const json = (result, status = 200) => new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.telegram.org/')) throw new Error('Unexpected external request');
  const method = String(url).split('/').pop();
  const payload = JSON.parse(options.body);
  if (method === 'getUpdates') {
    snapshot();
    stepIndex += 1;
    if (stepIndex >= steps.length) {
      const deadline = Date.now() + 5000;
      while (!broadcastDone && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      setTimeout(() => finish(broadcastDone ? undefined : new Error('Broadcast never finished')), 20);
      return new Promise(() => {});
    }
    const step = steps[stepIndex];
    transcript.push({ label: step.label });
    return json({ ok: true, result: [{ update_id: stepIndex + 1, ...step.build() }] });
  }
  if (method === 'getMe') return json({ ok: true, result: { id: 1, is_bot: true, username: 'membership_test_bot' } });
  if (method === 'getChatMember' && payload.user_id === 1) {
    return json({ ok: true, result: { status: 'member' } }); // setup warning, not a startup crash
  }
  transcript.push({ method, payload });
  if (method === 'getChatMember') {
    if (!options.signal) throw new Error('Membership request needs a timeout');
    const step = steps[stepIndex];
    if (step.timeout) throw new DOMException('Membership request timed out', 'TimeoutError');
    if (step.error && (!step.errorGroup || step.errorGroup === payload.chat_id)) return json({ ok: false, error_code: 400, description: step.error }, 400);
    return json({ ok: true, result: step.members?.[payload.chat_id] || step.member });
  }
  if (method === 'sendMessage' || method === 'editMessageText') {
    if (method === 'sendMessage' && payload.text?.includes('<b>Verifikasi semua user</b>')) {
      broadcastAttempts.push(payload);
      if (String(payload.chat_id) === REFERRER) return json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403);
    }
    if (method === 'editMessageText' && payload.text?.includes('Pengiriman verifikasi grup') && payload.text.includes('done')) broadcastDone = true;
    const sendButton = payload.reply_markup?.inline_keyboard?.flat().find(button => button.callback_data?.startsWith('admin_group_send_'));
    if (sendButton) adminSendButton = sendButton.callback_data;
    if (steps[stepIndex]?.label === 'start_blocked') {
      verificationButton = payload.reply_markup?.inline_keyboard?.flat().find(b => b.callback_data?.startsWith('group_verify'))?.callback_data;
    }
    return json({ ok: true, result: { message_id: ++messageId, chat: { id: payload.chat_id } } });
  }
  return json({ ok: true, result: true });
};
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('Membership harness timed out')), 15000).unref();
require(path.join(ROOT, 'telegram-bot'));

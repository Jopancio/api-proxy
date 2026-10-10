require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// All data calls are async: they hit local files or, when the bot runs on a
// different host than server.js, the API server's internal data endpoint.
const {
  adjustBalance, ensureUser, setUserLanguage, createApiKey, getAdminLogs, getAllUsers, getUser, getOrder, revokeApiKey, createOrder, settleOrder,
  createRedeemCode, redeemCode, listRedeemCodes, disableRedeemCode, getAdminStats, resetStats,
  createAccessCode, redeemAccessCode, listAccessCodes, getAccessCode, disableAccessCode, getModelAccess,
  getUsageSummary, listUsersPage,
  addTicketMessage, closeTicket, countOpenTickets, createTicket, findTicketByAdminMessage, getOpenTicketForUser,
  getTicket, linkAdminMessage, listTickets,
  createPoll, votePoll, getPoll, listPolls, closePoll, setPollSent,
  listPromptUsers, getUserPrompts, clearPrompts, clearAllPrompts, isPromptLogEnabled, setPromptLogEnabled,
  isAllModelsFree, isPaymentsEnabled, readSettings, setAllModelsFree, setPaymentsEnabled, setAnnouncement,
  getDisabledModels, setModelDisabled, setFamilyDisabled,
  getRateLimits, setModelRateLimit, setFamilyRateLimit,
  listBansos, createBansos, stopBansos,
  getModerationSettings, setModerationSettings, listModerationBlocks, getModerationBlock, clearModerationBlocks,
  getReferralInfo, startWithReferral, getReferralSettings, setReferralSettings,
  getCreditOverview, getCreditOrder, createCreditOrder, markCreditOrderFailed, settlePayment, adminConfirmCreditOrder,
  adjustCredits, refundCredits, getCreditStats, listCreditOrders, getCreditCatalog, getCreditAdmin, updateCreditConfig,
  saveModelCache, dataMode,
} = require('./data-client');
const { DEFAULT_MODEL_PRICE, PINNED_MODELS, getModelFamily, getModelPrice, stripModelPrefix, tokenAllowance } = require('./pricing');
// Pure helpers only (parsing admin commands, credit math for estimates); no data access.
const creditRules = require('./credit-rules');
const { getCashiPaymentStatus } = require('./cashi-client');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
// Endpoint shown to users: the public proxy, not the upstream behind it.
const PUBLIC_BASE_URL = 'http://103.247.8.69:3000/v1';
const CASHI_API_KEY = process.env.CASHI_API_KEY;
const CASHI_API_URL = 'https://cashi.id/api/create-order';
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '6957236291').trim();
const STORE_NAME = process.env.STORE_NAME || 'X Store';
const PAYMENTS_OFF_MESSAGE = '\u{1F6A7} <b>Pembelian paket token sedang ditutup sementara.</b>\n\nPembayaran belum bisa dilakukan saat ini. Silakan coba lagi nanti, atau gunakan <b>Redeem Code</b> kalau kamu punya kode. \u{1F39F}\u{FE0F}';
const PAYMENTS_OFF_ADMIN_HINT = '\n\n<i>Admin: buka lewat Admin Panel \u{2192} \u{1F513} Enable Payments.</i>';
// One label for every entry point to the credit packages (dashboard, Kredit Token screen).
const BUY_CREDITS_BUTTON = '\u{1F6D2} Beli Paket Token';
const REQUIRED_GROUPS = [
  { chatId: '@galaxy_hub_api', name: 'Galaxy Hub API', url: 'https://t.me/galaxy_hub_api' },
  { chatId: '@galaxy_testi', name: 'Galaxy Testi', url: 'https://t.me/galaxy_testi' },
];
const GROUP_VERIFY_ACTION = 'group_verify';
let membershipBroadcastDraft = null;
let membershipBroadcastStats = null;
const pendingAdminActions = new Set();
const pendingAdminTopups = new Map();
// Admin redeem-code wizard: { step: 'amount' } or { step: 'uses', amount }.
const pendingAdminRedeem = new Map();
// Users who pressed "Redeem Code" and whose next text message is the code.
const pendingUserRedeem = new Set();
// Users who pressed "Create Ticket" and whose next message opens the ticket.
const pendingUserTicket = new Set();
// Admin's active ticket chat: admin id -> ticket id. Admin messages go to that ticket's user.
const pendingAdminTicketReply = new Map();
// Admin typing an RPM value: { familyIndex, modelIndex? } (no modelIndex = family rule).
const pendingAdminRateLimit = new Map();
// Admin typing a referral setting: 'reward' (bonus tokens per invite) or 'cap' (max paid invites per user).
const pendingAdminReferral = new Map();
// BANSOS wizard draft per admin: { models: [], families: [], startsAt, endsAt, durationMs }.
// Survives button presses (unlike the text prompts) until it is created or cancelled.
const bansosDrafts = new Map();
// Admin typing a BANSOS time: 'start' or 'end'.
const pendingAdminBansos = new Map();
// Model access code wizard draft per admin: { models: [], kind: 'duration' | 'range', durationMs,
// expiresAt, startsAt, endsAt }. Survives button presses until it is created or cancelled.
const accessCodeDrafts = new Map();
// Admin typing a value for that draft: 'duration', 'expires', 'start' or 'end'.
const pendingAdminAccess = new Map();
// Admins whose next message is a user search (Admin Panel -> Users & Top Up -> Search).
const pendingAdminUserSearch = new Set();
// Last user list page and search per admin, so "Back" from a user's page returns to it.
const adminUserListState = new Map();
// Poll announcement wizard: admins whose next message is the poll text, and the parsed
// draft ({ question, options }) waiting for "Send". The draft survives button presses.
const pendingAdminPoll = new Set();
const pollDrafts = new Map();
// Admin typing credit commands (Admin Panel -> Kredit & Paket): { mode: 'console' } or
// { mode: 'user', targetId } for one user's credit adjustment.
const pendingAdminCredit = new Map();
// Keep the admin's multiplier search/page when returning from a model editor.
const adminMultiplierLists = new Map();
const MAX_REFERRAL_REWARD = 1_000_000_000;
const MAX_REFERRAL_CAP = 100_000;
// Set from getMe at startup; used to build t.me/<bot>?start=<code> referral links.
let botUsername = '';
const REDEEM_CODE_PATTERN = /^RDM-[A-F0-9]{6}-[A-F0-9]{6}$/i;
// Model access codes (Admin Panel -> Kode Akses Model); same format as usage-db.js.
const ACCESS_CODE_PATTERN = /^MDL-[A-F0-9]{6}-[A-F0-9]{6}$/i;
const MAX_REDEEM_AMOUNT = 100_000_000;
const MAX_REDEEM_USES = 10_000;

function isAdmin(userId) {
  return String(userId) === ADMIN_TELEGRAM_ID;
}

function clearPendingInput(userId) {
  const id = String(userId);
  pendingAdminActions.delete(id);
  pendingAdminTopups.delete(id);
  pendingAdminRedeem.delete(id);
  pendingUserRedeem.delete(id);
  pendingUserTicket.delete(id);
  pendingAdminTicketReply.delete(id);
  pendingAdminRateLimit.delete(id);
  pendingAdminReferral.delete(id);
  pendingAdminBansos.delete(id);
  pendingAdminAccess.delete(id);
  pendingAdminUserSearch.delete(id);
  pendingAdminPoll.delete(id);
  pendingAdminCredit.delete(id);
}

// Accepts "25000", "25.000", "Rp25.000", "25,000".
function parseNominal(text) {
  const digits = String(text || '').replace(/rp/gi, '').replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function rupiah(value) {
  return `Rp${Math.round(Number(value || 0)).toLocaleString('id-ID')}`;
}

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
    ...(method === 'getChatMember' ? { signal: AbortSignal.timeout(10_000) } : {}),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const description = result.description || `Telegram API error (${response.status})`;
    // Telegram refuses the WHOLE message when a Mini App button is invalid (e.g. a wrong
    // ADMIN_MINI_APP_URL), which would keep the Admin Panel from opening. Send it again with
    // the setup button in its place instead.
    if (hasMiniAppButton(payload.reply_markup) && /web ?app|BUTTON_TYPE_INVALID|BUTTON_URL_INVALID/i.test(description)) {
      if (/url/i.test(description) && !miniAppUrlRejection) {
        miniAppUrlRejection = description;
        console.error(`[mini-app] Telegram refused ADMIN_MINI_APP_URL: ${description}`);
      }
      return telegram(method, { ...payload, reply_markup: withoutMiniAppButton(payload.reply_markup) });
    }
    const error = new Error(description);
    // Used by the broadcast: 403 = blocked / deleted account, 429 = slow down for retryAfter seconds.
    error.code = Number(result.error_code || response.status) || 0;
    if (result.parameters?.retry_after) error.retryAfter = Number(result.parameters.retry_after);
    throw error;
  }
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

// ---------- Layout helpers for the dashboard / API dashboard / admin panel ----------
const DIVIDER = '\u{2501}'.repeat(18);

// "▰▰▰▰▰▰▰▰▱▱" for a 0-100 percentage.
function progressBar(percent, size = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, Number(percent) || 0)) / 100) * size);
  return '\u{25B0}'.repeat(filled) + '\u{25B1}'.repeat(size - filled);
}

// 15300000 -> "15,3 jt", 1200 -> "1,2 rb" (shown next to the exact number).
function shortNumber(value) {
  const number = Number(value || 0);
  const units = [[1e12, 'T'], [1e9, 'M'], [1e6, 'jt'], [1e3, 'rb']];
  for (const [size, unit] of units) {
    if (Math.abs(number) >= size) return `${(number / size).toLocaleString('id-ID', { maximumFractionDigits: 1 })} ${unit}`;
  }
  return number.toLocaleString('id-ID');
}

// Exact number, plus the short form when it is large enough to be hard to read.
function bigNumber(value) {
  const number = Number(value || 0);
  return Math.abs(number) >= 1e6 ? `${formatTokens(number)} <i>(${shortNumber(number)})</i>` : formatTokens(number);
}

function wibTime(iso) {
  if (!iso) return '-';
  return `${new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })} WIB`;
}

// Tree-style list: "├ a", "├ b", "└ c".
function tree(lines) {
  const items = lines.filter(Boolean);
  return items.map((line, index) => `${index === items.length - 1 ? '\u{2514}' : '\u{251C}'} ${line}`).join('\n');
}

// A titled card. Telegram renders <blockquote> as an indented box.
function card(title, lines) {
  return `<blockquote>${title}\n${tree(lines)}</blockquote>`;
}

function menuKeyboard(userId = '') {
  const rows = [
    [{ text: '\u{1F4CA} API Dashboard', callback_data: 'dashboard' }, { text: '\u{1F9FE} Logs', callback_data: 'logs' }],
    [{ text: '\u{1F39F}\u{FE0F} Redeem Code', callback_data: 'redeem' }, { text: '\u{1F91D} Referral', callback_data: 'referral' }],
    [{ text: '\u{1F3AB} Create a Ticket', callback_data: 'ticket' }],
  ];
  if (String(userId) === ADMIN_TELEGRAM_ID) rows.push([{ text: '\u{1F6E0}\u{FE0F} Admin Panel', callback_data: 'admin_panel' }]);
  return { inline_keyboard: rows };
}

function dashboardKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F48E} Kredit Token', callback_data: 'credits' }, { text: BUY_CREDITS_BUTTON, callback_data: 'top_up' }],
    [{ text: '\u{267E}\u{FE0F} Unlimited Model China', callback_data: 'cr_ul' }],
    [{ text: '\u{1F4CB} Model & Multiplier', callback_data: 'cr_models' }, { text: '\u{1F9FE} Logs', callback_data: 'logs' }],
    [{ text: '\u{1F4C8} Usage Summary', callback_data: 'usage' }],
    [{ text: '\u{1F511} Create new API key', callback_data: 'create_key' }, { text: '\u{1F5D1}\u{FE0F} Revoke API Key', callback_data: 'revoke' }],
    [{ text: '\u{1F3AB} Create a Ticket', callback_data: 'ticket' }, { text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function modelKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F4CB} Model & Multiplier (kredit)', callback_data: 'cr_models' }],
    [{ text: '\u{1F504} Resync Models', callback_data: 'model_resync' }],
    [{ text: '\u{1F519} Back to dashboard', callback_data: 'dashboard' }],
  ] };
}

// ---------- Admin stats Mini App ----------
// server.js serves the page at /admin/app and gives its stats only to the admin: it verifies
// the launch data Telegram signs with this bot's token. Telegram opens Mini Apps over HTTPS
// only, so the button needs ADMIN_MINI_APP_URL=https://<address>/admin/app; until then the
// same button explains the setup.
const MINI_APP_BUTTON_TEXT = '\u{1F4F1} Stats Mini App';
// Telegram's reason when it refused the configured URL; the setup button is shown instead.
let miniAppUrlRejection = '';

function adminMiniAppUrl() {
  if (miniAppUrlRejection) return '';
  try {
    const url = new URL(String(process.env.ADMIN_MINI_APP_URL || '').trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function adminMiniAppButton() {
  const url = adminMiniAppUrl();
  return url ? { text: MINI_APP_BUTTON_TEXT, web_app: { url } } : { text: MINI_APP_BUTTON_TEXT, callback_data: 'admin_app' };
}

function hasMiniAppButton(markup) {
  return Boolean(markup?.inline_keyboard?.some((row) => Array.isArray(row) && row.some((button) => button?.web_app)));
}

function withoutMiniAppButton(markup) {
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) => row.map((button) => (button?.web_app ? { text: button.text, callback_data: 'admin_app' } : button))),
  };
}

function adminMiniAppSetupMessage() {
  const configured = String(process.env.ADMIN_MINI_APP_URL || '').trim();
  const problem = miniAppUrlRejection
    ? `\u{26A0}\u{FE0F} Telegram refused <code>ADMIN_MINI_APP_URL</code>:\n<code>${escapeHtml(miniAppUrlRejection)}</code>\nFix the address and restart the bot.`
    : configured
      ? `\u{26A0}\u{FE0F} <code>ADMIN_MINI_APP_URL</code> is set to <code>${escapeHtml(configured)}</code>, which is not an <b>https://</b> address.`
      : '';
  return [
    '\u{1F4F1} <b>Stats Mini App</b> is not set up yet.',
    '',
    'It shows every Admin Dashboard stat on one screen, and only the admin can open it. Telegram opens Mini Apps over <b>HTTPS</b> only, so:',
    '1. Give server.js a public HTTPS address (a domain with a TLS reverse proxy, or a tunnel).',
    '2. Bot host: set <code>ADMIN_MINI_APP_URL=https://&lt;address&gt;/admin/app</code> and restart the bot.',
    '3. server.js host: make sure <code>TELEGRAM_BOT_TOKEN</code> holds this bot\'s token, then restart server.js.',
    ...(problem ? ['', problem] : []),
  ].join('\n');
}

async function adminKeyboard() {
  return { inline_keyboard: [
    // Monitoring
    [{ text: '\u{1F504} Refresh Stats', callback_data: 'admin_panel' }, { text: '\u{1F465} Top Users', callback_data: 'admin_users' }],
    [{ text: '\u{1F4DC} Request Logs', callback_data: 'admin_logs' }, { text: `\u{1F3AB} Tickets (${await countOpenTickets()})`, callback_data: 'admin_tickets' }],
    [adminMiniAppButton(), {
      // An outdated API server without this feature simply reads as OFF.
      text: `\u{1F4AC} Recent Prompts (${await isPromptLogEnabled().then((on) => (on ? 'ON' : 'OFF'), () => 'OFF')})`,
      callback_data: 'admin_prompts',
    }],
    [{
      // An outdated API server without this feature reads as OFF (and the screen explains why).
      text: `\u{1F6E1}\u{FE0F} AI Moderation (${await getModerationSettings().then((settings) => (settings.enabled ? 'ON' : 'OFF'), () => 'OFF')})`,
      callback_data: 'admin_mod',
    }],
    // Balance & codes
    [{ text: '\u{1F39F}\u{FE0F} Redeem Codes', callback_data: 'admin_redeem' }, { text: '\u{1F464} Users & Top Up', callback_data: 'admin_topup' }],
    [{ text: '\u{1F510} Kode Akses Model', callback_data: 'admin_mac' }, { text: '\u{1F48E} Kredit & Paket', callback_data: 'admin_cr' }],
    [{ text: '\u{2716}\u{FE0F} Atur Multiplier', callback_data: 'admin_cr_rates' }],
    // Settings & broadcast
    [{ text: '\u{1F465} Verifikasi Semua User', callback_data: 'admin_groups' }],
    [
      { text: await isAllModelsFree() ? '\u{1F534} Disable Free Mode' : '\u{1F7E2} Free Mode', callback_data: 'admin_free_toggle' },
      { text: '\u{1F4E2} Announcement', callback_data: 'admin_announce' },
    ],
    [{
      text: await isPaymentsEnabled() ? '\u{1F512} Disable Payments' : '\u{1F513} Enable Payments',
      callback_data: 'admin_payments_toggle',
    }, { text: '\u{1F6AB} Disable Model', callback_data: 'admin_models' }],
    [{ text: '\u{23F1}\u{FE0F} Rate Limit', callback_data: 'admin_rl' }, { text: '\u{267B}\u{FE0F} Reset Stats', callback_data: 'admin_reset_stats' }],
    [{ text: '\u{1F91D} Referral', callback_data: 'admin_ref' }, { text: '\u{1F381} BANSOS', callback_data: 'admin_bsn' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function adminBackKeyboard() {
  return { inline_keyboard: [[{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]] };
}

function adminRedeemKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{2795} Create Code', callback_data: 'admin_redeem_create' }, { text: '\u{1F4CB} List Codes', callback_data: 'admin_redeem_list' }],
    [{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }],
  ] };
}

function adminRedeemAmountKeyboard() {
  return { inline_keyboard: [
    [{ text: 'Rp10.000', callback_data: 'admin_redeem_amt_10000' }, { text: 'Rp25.000', callback_data: 'admin_redeem_amt_25000' }],
    [{ text: 'Rp50.000', callback_data: 'admin_redeem_amt_50000' }, { text: 'Rp100.000', callback_data: 'admin_redeem_amt_100000' }],
    [{ text: '\u{274C} Cancel', callback_data: 'admin_redeem' }],
  ] };
}

function adminRedeemUsesKeyboard(amount) {
  const make = (uses) => ({ text: `${uses}x`, callback_data: `admin_redeem_make_${amount}_${uses}` });
  return { inline_keyboard: [
    [make(1), make(5), make(10)],
    [make(25), make(50), make(100)],
    [{ text: '\u{270F}\u{FE0F} Custom quota', callback_data: `admin_redeem_uses_custom_${amount}` }],
    [{ text: '\u{274C} Cancel', callback_data: 'admin_redeem' }],
  ] };
}

function adminRedeemListKeyboard(codes) {
  const rows = codes
    .filter((entry) => entry.active !== false && (entry.redemptions || []).length < entry.maxUses)
    .slice(0, 8)
    .map((entry) => [{ text: `\u{1F6AB} Disable ${entry.code}`, callback_data: `admin_redeem_off_${entry.code}` }]);
  rows.push([{ text: '\u{2795} Create Code', callback_data: 'admin_redeem_create' }, { text: '\u{1F519} Back', callback_data: 'admin_redeem' }]);
  return { inline_keyboard: rows };
}

function redeemCodeStatus(entry) {
  const used = (entry.redemptions || []).length;
  if (entry.active === false) return '\u{1F6AB} disabled';
  if (used >= entry.maxUses) return '\u{2705} used up';
  return '\u{1F7E2} active';
}

function adminRedeemListMessage(codes) {
  if (!codes.length) return '\u{1F4CB} <b>Redeem Codes</b>\n\nNo codes created yet.';
  const lines = codes.map((entry) => {
    const used = (entry.redemptions || []).length;
    return `<code>${escapeHtml(entry.code)}</code>\n   ${rupiah(entry.amount)} • used ${used}/${entry.maxUses} • ${redeemCodeStatus(entry)}`;
  });
  return `\u{1F4CB} <b>Redeem Codes</b> (latest ${codes.length})\n\n${lines.join('\n')}`;
}

async function adminTopUsersMessage() {
  const users = (await getAllUsers())
    .sort((a, b) => Number(b.stats?.totalTokens || 0) - Number(a.stats?.totalTokens || 0))
    .slice(0, 10);
  if (!users.length) return '\u{1F465} <b>Top Users</b>\n\nNo users yet.';
  const lines = users.map((user, index) => {
    const s = user.stats || {};
    const name = escapeHtml(user.firstName || user.username || user.telegramId);
    return [
      `<b>${index + 1}. ${name}</b> <code>${escapeHtml(user.telegramId)}</code>`,
      `   \u{1F4C8} ${formatTokens(s.requests)} req • \u{26A0}\u{FE0F} ${formatTokens(s.errors)} err • \u{1F522} ${formatTokens(s.totalTokens)} tok`,
      `   \u{1F4B8} spent ${formatCost(s.spent)} • \u{1F4B0} balance ${rupiah(user.balance)}`,
    ].join('\n');
  });
  return `\u{1F465} <b>Top Users</b> (by tokens)\n\n${lines.join('\n\n')}`;
}

// ---------- Admin: Users & Top Up ----------
// A paged user list (most recently active first) with search, and one page per user with
// everything about them plus the top-up buttons. The API server builds the pages (listUsersPage),
// so the bot never loads every full user record just to draw a list. Names and usernames are user
// input: always escaped.
const USER_LIST_PAGE_SIZE = 10;
const USER_SEARCH_MAX = 64;
const USER_ID_PATTERN = /^\d{1,20}$/;
const TOPUP_PRESETS = [10_000, 50_000, 100_000, 500_000];

function userDisplayName(user) {
  return clipChars(String(user.firstName || (user.username ? `@${user.username}` : '') || `ID ${user.telegramId}`), 40);
}

// Same result shape as usage-db.js listUsersPage, for an API server without it yet.
function localUsersPage(users, { page = 0, pageSize = USER_LIST_PAGE_SIZE, query = '' } = {}) {
  const text = String(query || '').trim().toLowerCase();
  const handle = text.replace(/^@/, '');
  const activity = (user) => String(user.lastUsedAt || user.createdAt || '');
  const list = users
    .filter((user) => user && user.telegramId)
    .filter((user) => !handle || String(user.telegramId).includes(handle)
      || String(user.username || '').toLowerCase().includes(handle) || String(user.firstName || '').toLowerCase().includes(handle))
    .sort((a, b) => activity(b).localeCompare(activity(a)));
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const current = Math.min(pages - 1, Math.max(0, Number(page) || 0));
  return {
    total: list.length,
    page: current,
    pages,
    pageSize,
    query: text,
    users: list.slice(current * pageSize, (current + 1) * pageSize).map((user) => ({
      telegramId: String(user.telegramId),
      firstName: user.firstName || '',
      username: user.username || '',
      balance: Number(user.balance || 0),
      requests: Number(user.stats?.requests || 0),
      lastUsedAt: user.lastUsedAt || null,
      createdAt: user.createdAt || null,
    })),
  };
}

async function fetchUsersPage(options) {
  try {
    return await listUsersPage({ pageSize: USER_LIST_PAGE_SIZE, ...options });
  } catch (error) {
    console.error('[users] listUsersPage unavailable, listing locally:', error.message);
    return localUsersPage(await getAllUsers(), { pageSize: USER_LIST_PAGE_SIZE, ...options });
  }
}

function userListState(adminId) {
  return adminUserListState.get(String(adminId)) || { page: 0, query: '' };
}

async function adminUserListView(adminId, notice = '') {
  const state = userListState(adminId);
  const result = await fetchUsersPage({ page: state.page, query: state.query });
  adminUserListState.set(String(adminId), { page: result.page, query: state.query });
  const first = result.page * result.pageSize;
  const lines = [
    ...(notice ? [notice, ''] : []),
    '\u{1F464} <b>Users &amp; Top Up</b>',
    state.query
      ? `\u{1F50D} Hasil untuk <b>${escapeHtml(state.query)}</b>: <b>${formatTokens(result.total)}</b> user`
      : `Total: <b>${formatTokens(result.total)}</b> user \u{2022} terbaru aktif di atas`,
    DIVIDER,
    ...(result.users.length
      ? result.users.map((user, index) => [
        `${first + index + 1}. <b>${escapeHtml(userDisplayName(user))}</b>${user.username && user.firstName ? ` @${escapeHtml(clipChars(user.username, 32))}` : ''} <code>${escapeHtml(user.telegramId)}</code>`,
        `   \u{1F4B0} ${rupiah(user.balance)} \u{2022} \u{1F4E1} ${formatTokens(user.requests)} req \u{2022} \u{1F552} ${escapeHtml(user.lastUsedAt ? wibTime(user.lastUsedAt) : 'belum pernah')}`,
      ].join('\n'))
      : [state.query ? 'Tidak ada user yang cocok.' : 'Belum ada user.']),
    '',
    `<i>Halaman ${result.page + 1}/${result.pages}. Tap user untuk detail &amp; top up.</i>`,
  ];
  const rows = result.users.map((user, index) => [{
    text: `${first + index + 1}. ${userDisplayName(user)} \u{2014} ${rupiah(user.balance)}`.slice(0, 60),
    callback_data: `admin_topup_user_${user.telegramId}`,
  }]);
  if (result.pages > 1) {
    const nav = [];
    if (result.page > 0) nav.push({ text: '\u{25C0}\u{FE0F} Sebelumnya', callback_data: `admin_ul_p_${result.page - 1}` });
    if (result.page < result.pages - 1) nav.push({ text: 'Berikutnya \u{25B6}\u{FE0F}', callback_data: `admin_ul_p_${result.page + 1}` });
    rows.push(nav);
  }
  rows.push(state.query
    ? [{ text: '\u{1F50D} Cari lagi', callback_data: 'admin_ul_search' }, { text: '\u{2716}\u{FE0F} Hapus pencarian', callback_data: 'admin_ul_clear' }]
    : [{ text: '\u{1F50D} Cari user (ID / @username / nama)', callback_data: 'admin_ul_search' }]);
  rows.push([{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// "sk-user-1a2b…9z8y": enough to tell keys apart, not enough to use one.
function maskApiKey(key) {
  const value = String(key || '');
  return value.length > 16 ? `${value.slice(0, 12)}\u{2026}${value.slice(-4)}` : '\u{2026}';
}

function userLogLine(entry) {
  const total = Number(entry.inputTokens || 0) + Number(entry.outputTokens || 0);
  const model = escapeHtml(clipChars(stripModelPrefix(entry.model) || 'unknown', 32));
  // "2026-10-04 15:48:09" -> "04/10 15:48" (WIB).
  const time = wibLogTime(entry.at);
  const when = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(time) ? `${time.slice(8, 10)}/${time.slice(5, 7)} ${time.slice(11, 16)}` : time;
  const charge = entry.funding === 'credits'
    ? `\u{1F48E} ${formatTokens(entry.credits)} kr (${multiplierText(entry.multiplier || '?')})`
    : entry.funding === 'unlimited' ? '\u{267E}\u{FE0F} unlimited' : formatCost(entry.cost);
  return `${entry.status >= 400 ? '\u{274C}' : '\u{2705}'} ${escapeHtml(when)} <code>${model}</code> \u{2022} ${formatTokens(total)} tok${entry.estimated ? ' (est.)' : ''} \u{2022} ${charge}`;
}

function adminUserKeyboard(user, { ticket, access } = {}) {
  const id = user.telegramId;
  const preset = (amount) => ({ text: `+${rupiah(amount)}`, callback_data: `admin_topup_amount_${id}_${amount}` });
  const rows = [
    [preset(TOPUP_PRESETS[0]), preset(TOPUP_PRESETS[1])],
    [preset(TOPUP_PRESETS[2]), preset(TOPUP_PRESETS[3])],
    [{ text: '\u{270F}\u{FE0F} Tambah / kurangi (custom)', callback_data: `admin_topup_custom_${id}` }],
    [{ text: '\u{1F48E} Kredit token: tambah / kurangi / refund', callback_data: `admin_cr_user_${id}` }],
    [{ text: '\u{1F4C8} Pemakaian 30 hari', callback_data: `admin_uu_${id}_30` }, { text: '\u{1F4AC} Prompts', callback_data: `admin_prompts_u_${id}` }],
  ];
  if (ticket) rows.push([{ text: `\u{1F3AB} Ticket #${ticket.id} (terbuka)`, callback_data: `admin_ticket_view_${ticket.id}` }]);
  for (const grant of [...(access?.active || []), ...(access?.scheduled || [])].slice(0, 2)) {
    rows.push([{ text: `\u{1F510} ${grant.code}`, callback_data: `admin_mac_v_${grant.code}` }]);
  }
  rows.push([{ text: '\u{1F504} Refresh', callback_data: `admin_topup_user_${id}` }, { text: '\u{1F519} Daftar user', callback_data: 'admin_ul_back' }]);
  return { inline_keyboard: rows };
}

// Everything about one user on one screen. Newer data (access codes, usage summary, tickets) is
// left out when the API server does not have it yet.
async function adminUserDetailView(targetId, notice = '') {
  const user = USER_ID_PATTERN.test(String(targetId)) ? await getUser(targetId) : null;
  if (!user) return null;
  const id = String(user.telegramId);
  const [access, week, ticket, credit] = await Promise.all([
    getModelAccess(id).catch(() => null),
    getUsageSummary(id, 7).catch(() => null),
    getOpenTicketForUser(id).catch(() => null),
    getCreditOverview(id).catch(() => null),
  ]);
  const stats = user.stats || {};
  const requests = Number(stats.requests || 0);
  const errors = Number(stats.errors || 0);
  const keys = Array.isArray(user.apiKeys) ? user.apiKeys : [];
  const activeKeys = keys.filter((entry) => entry.active !== false);
  const orders = Array.isArray(user.orders) ? user.orders : [];
  const settled = orders.filter((order) => order.status === 'SETTLED');
  const pending = orders.filter((order) => order.status === 'PENDING').length;
  const referral = user.referralStats || {};
  const language = { id: 'Indonesia', en: 'English' }[user.language] || '-';
  const logs = (Array.isArray(user.logs) ? user.logs : []).slice(-5).reverse();
  const grants = [...(access?.active || []), ...(access?.scheduled || [])];

  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F464} <b>${escapeHtml(userDisplayName(user))}</b>${user.username ? ` @${escapeHtml(clipChars(user.username, 32))}` : ''}`,
    `\u{1F194} <code>${escapeHtml(id)}</code> \u{2022} \u{1F310} ${language}`,
    `\u{1F4C5} Bergabung: ${escapeHtml(wibTime(user.createdAt))}`,
    `\u{1F552} Terakhir pakai API: ${escapeHtml(user.lastUsedAt ? wibTime(user.lastUsedAt) : 'belum pernah')}`,
    '',
    card('\u{1F4B3} <b>Saldo</b>', [
      `Saldo: <b>${rupiah(user.balance)}</b>`,
      Number(user.bonusTokens || 0) > 0 && `Bonus token: <b>${bigNumber(user.bonusTokens)}</b>`,
      `Total terpakai: <b>${formatCost(stats.spent)}</b>`,
      `Top up lunas: <b>${rupiah(settled.reduce((sum, order) => sum + Number(order.amount || 0), 0))}</b> (${formatTokens(settled.length)}x)${pending ? ` \u{2022} ${formatTokens(pending)} pending` : ''}`,
    ]),
    ...(credit ? [card('\u{1F48E} <b>Kredit token</b>', [
      `Tersedia: <b>${bigNumber(credit.account.available)}</b> \u{2022} direservasi: <b>${bigNumber(credit.account.reserved)}</b>`,
      `Dibeli: ${bigNumber(credit.account.purchased)} \u{2022} terpakai: ${bigNumber(credit.account.used)} \u{2022} refund: ${bigNumber(credit.account.refunded)} \u{2022} admin: ${formatTokens(credit.account.adjusted)}`,
      ...[...credit.passes.active, ...credit.passes.scheduled].slice(0, 2).map((pass) => `\u{267E}\u{FE0F} ${escapeHtml(pass.name || 'Unlimited')} ${pass.status === 'active' ? 's/d' : 'mulai'} ${escapeHtml(wibTime(pass.status === 'active' ? pass.endsAt : pass.startsAt))}`),
    ])] : []),
    card('\u{1F4C8} <b>Pemakaian</b>', [
      `Total: <b>${formatTokens(requests)}</b> req (\u{26A0}\u{FE0F} ${formatTokens(errors)} error) \u{2022} <b>${bigNumber(stats.totalTokens)}</b> token`,
      week && `7 hari: <b>${formatTokens(week.totals.requests)}</b> req \u{2022} <b>${bigNumber(week.totals.totalTokens)}</b> token \u{2022} <b>${formatCost(week.totals.cost)}</b>`,
      week && week.models.length && `Model teratas (7 hari): ${week.models.slice(0, 3).map((entry) => `<code>${escapeHtml(entry.model)}</code>`).join(' \u{2022} ')}`,
    ]),
    card('\u{1F511} <b>API key</b>', [
      `Aktif: <b>${formatTokens(activeKeys.length)}</b> dari ${formatTokens(keys.length)}`,
      ...activeKeys.slice(0, 3).map((entry) => `<code>${escapeHtml(maskApiKey(entry.key))}</code> \u{2022} ${escapeHtml(wibTime(entry.createdAt))}`),
      activeKeys.length > 3 && `+${formatTokens(activeKeys.length - 3)} key lainnya`,
    ]),
  ];
  if (grants.length) {
    lines.push(card('\u{1F510} <b>Kode akses model</b>', grants.slice(0, 4).map((grant) => (grant.status === 'active'
      ? `<code>${escapeHtml(grant.code)}</code> s/d ${escapeHtml(wibTime(grant.endsAt))}: ${accessModelsText(grant.models, 3)}`
      : `\u{23F3} <code>${escapeHtml(grant.code)}</code> mulai ${escapeHtml(wibTime(grant.startsAt))}: ${accessModelsText(grant.models, 3)}`))));
  }
  lines.push(card('\u{1F91D} <b>Referral</b>', [
    `Diundang oleh: ${user.referredBy?.telegramId ? `<code>${escapeHtml(user.referredBy.telegramId)}</code>` : '-'}`,
    `Mengundang: <b>${formatTokens(referral.invites || 0)}</b> (dibayar ${formatTokens(referral.rewarded || 0)}) \u{2022} ${bigNumber(referral.tokensEarned || 0)} token`,
  ]));
  if (ticket) lines.push(`\u{1F3AB} Ticket terbuka: <b>#${escapeHtml(ticket.id)}</b>`);
  lines.push(card('\u{1F9FE} <b>Request terakhir</b>', logs.length ? logs.map(userLogLine) : ['Belum ada.']));
  return { text: lines.join('\n'), reply_markup: adminUserKeyboard(user, { ticket, access }) };
}

// Sends the user's page (or the list with a notice when the user is gone).
async function sendAdminUserDetail(chatId, adminId, targetId, notice = '') {
  const view = await adminUserDetailView(targetId, notice);
  const shown = view || await adminUserListView(adminId, '\u{274C} User tidak ditemukan.');
  return telegram('sendMessage', { chat_id: chatId, text: shown.text, parse_mode: 'HTML', reply_markup: shown.reply_markup });
}

// Typed search: one match opens that user's page right away, otherwise the list of matches.
async function handleUserSearchInput(chatId, adminId, text) {
  const query = String(text || '').trim().slice(0, USER_SEARCH_MAX);
  if (!query) return telegram('sendMessage', { chat_id: chatId, text: '\u{274C} Kirim ID, @username atau nama user.' });
  pendingAdminUserSearch.delete(String(adminId));
  adminUserListState.set(String(adminId), { page: 0, query });
  const result = await fetchUsersPage({ page: 0, query });
  if (result.total === 1) return sendAdminUserDetail(chatId, adminId, result.users[0].telegramId);
  const view = await adminUserListView(adminId);
  return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
}

// ---------- Usage summary (API Dashboard -> Usage Summary, /usage; admin user page) ----------
// Per model and per day (WIB) from usage-db.js getUsageSummary. Counting started when the summary
// was added, so older usage only shows in the totals on the dashboard.
const USAGE_PERIODS = [1, 7, 30];
const USAGE_MODELS_SHOWN = 8;
const USAGE_TEXT = {
  id: {
    title: 'RINGKASAN PEMAKAIAN',
    periods: { 1: 'Hari ini', 7: '7 hari', 30: '30 hari' },
    total: 'Total',
    requests: 'request',
    errors: 'error',
    tokens: 'token',
    cost: 'Biaya',
    perModel: 'Per model',
    perDay: 'Per hari',
    average: 'Rata-rata per hari',
    busiest: 'Hari tersibuk',
    none: 'Belum ada pemakaian di periode ini. \u{1F4ED}',
    since: (day) => `Ringkasan tercatat sejak ${day}; pemakaian sebelumnya tidak termasuk.`,
    more: (count) => `+${count} model lainnya`,
    locale: 'id-ID',
    logs: '\u{1F9FE} Logs',
    back: '\u{1F519} Back to dashboard',
    unavailable: '\u{26A0}\u{FE0F} Ringkasan pemakaian belum tersedia di server. Coba lagi nanti.',
  },
  en: {
    title: 'USAGE SUMMARY',
    periods: { 1: 'Today', 7: '7 days', 30: '30 days' },
    total: 'Total',
    requests: 'requests',
    errors: 'errors',
    tokens: 'tokens',
    cost: 'Cost',
    perModel: 'Per model',
    perDay: 'Per day',
    average: 'Daily average',
    busiest: 'Busiest day',
    none: 'No usage in this period yet. \u{1F4ED}',
    since: (day) => `The summary is recorded since ${day}; earlier usage is not included.`,
    more: (count) => `+${count} more models`,
    locale: 'en-GB',
    logs: '\u{1F9FE} Logs',
    back: '\u{1F519} Back to dashboard',
    unavailable: '\u{26A0}\u{FE0F} The usage summary is not available on the server yet. Please try again later.',
  },
};

// "2026-10-03" -> "Sab, 03 Okt" / "Sat, 03 Oct" (the date is already a WIB day).
function usageDayLabel(date, locale, withWeekday = true) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    timeZone: 'UTC', day: '2-digit', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}),
  });
}

// `options` = { lang, days, periodData (callback prefix), back: [buttons], heading? }.
function usageSummaryView(summary, { lang = DEFAULT_LANGUAGE, days = 7, periodData = 'usage_', back = [], heading = '' } = {}) {
  const t = USAGE_TEXT[lang] || USAGE_TEXT[DEFAULT_LANGUAGE];
  const periodRow = USAGE_PERIODS.map((period) => ({
    text: `${period === days ? '\u{2705} ' : ''}${t.periods[period]}`,
    callback_data: `${periodData}${period}`,
  }));
  const keyboard = { inline_keyboard: [periodRow, ...(back.length ? [back] : [])] };
  if (!summary) return { text: t.unavailable, reply_markup: keyboard };
  const totals = summary.totals;
  const range = summary.days === 1
    ? usageDayLabel(summary.to, t.locale)
    : `${usageDayLabel(summary.from, t.locale, false)} \u{2013} ${usageDayLabel(summary.to, t.locale, false)}`;
  const lines = [
    `\u{1F4C8} <b>${t.title}</b> \u{2014} ${t.periods[days] || `${summary.days}d`}`,
    ...(heading ? [heading] : []),
    `<i>${escapeHtml(range)} (WIB)</i>`,
    DIVIDER,
  ];
  if (!totals.requests) {
    lines.push(t.none);
  } else {
    lines.push(card(`\u{1F9EE} <b>${t.total}</b>`, [
      `\u{1F4E8} <b>${formatTokens(totals.requests)}</b> ${t.requests}${totals.errors ? ` (\u{26A0}\u{FE0F} ${formatTokens(totals.errors)} ${t.errors})` : ''}`,
      `\u{1F4E5} ${bigNumber(totals.inputTokens)} \u{2022} \u{1F4E4} ${bigNumber(totals.outputTokens)}`,
      `\u{1F522} <b>${bigNumber(totals.totalTokens)}</b> ${t.tokens}`,
      `\u{1F4B8} ${t.cost}: <b>${formatCost(totals.cost)}</b>`,
      totals.credits > 0 && `\u{1F48E} ${lang === 'en' ? 'Credits' : 'Kredit'}: <b>${bigNumber(totals.credits)}</b>`,
    ]));
    const byTokens = totals.totalTokens > 0;
    const modelLines = summary.models.slice(0, USAGE_MODELS_SHOWN).map((entry) => {
      const share = byTokens ? (entry.totalTokens / totals.totalTokens) * 100 : (entry.requests / totals.requests) * 100;
      return [
        `<code>${escapeHtml(entry.model)}</code> ${progressBar(share, 8)} <b>${share.toFixed(share < 10 ? 1 : 0)}%</b>`,
        `   ${formatTokens(entry.requests)} req \u{2022} ${bigNumber(entry.totalTokens)} tok \u{2022} ${formatCost(entry.cost)}${entry.credits ? ` \u{2022} \u{1F48E} ${shortNumber(entry.credits)}` : ''}`,
      ].join('\n');
    });
    if (summary.models.length > USAGE_MODELS_SHOWN) modelLines.push(`<i>${t.more(summary.models.length - USAGE_MODELS_SHOWN)}</i>`);
    lines.push('', `\u{1F916} <b>${t.perModel}</b>`, ...modelLines);
    const activeDays = summary.daily.filter((day) => day.requests > 0);
    if (summary.days === 7) {
      const peak = Math.max(1, ...summary.daily.map((day) => day.totalTokens));
      lines.push('', `\u{1F4C5} <b>${t.perDay}</b>`, ...summary.daily.map((day) => (day.requests
        ? `<code>${escapeHtml(usageDayLabel(day.date, t.locale))}</code> ${progressBar((day.totalTokens / peak) * 100, 6)} ${shortNumber(day.totalTokens)} tok \u{2022} ${formatCost(day.cost)}`
        : `<code>${escapeHtml(usageDayLabel(day.date, t.locale))}</code> \u{2014}`)));
    } else if (summary.days > 7 && activeDays.length) {
      const busiest = activeDays.reduce((best, day) => (day.totalTokens > best.totalTokens ? day : best));
      lines.push('', card(`\u{1F4C5} <b>${t.perDay}</b>`, [
        `${t.average}: <b>${bigNumber(Math.round(totals.totalTokens / summary.days))}</b> tok \u{2022} ${formatCost(totals.cost / summary.days)}`,
        `${t.busiest}: <b>${escapeHtml(usageDayLabel(busiest.date, t.locale))}</b> \u{2022} ${bigNumber(busiest.totalTokens)} tok \u{2022} ${formatCost(busiest.cost)}`,
      ]));
    }
  }
  if (!summary.trackedSince || summary.trackedSince > summary.from) {
    lines.push('', `<i>${escapeHtml(t.since(summary.trackedSince ? usageDayLabel(summary.trackedSince, t.locale, false) : usageDayLabel(summary.to, t.locale, false)))}</i>`);
  }
  return { text: lines.join('\n'), reply_markup: keyboard };
}

async function userUsageView(telegramId, days) {
  const account = await getUser(telegramId).catch(() => null);
  const lang = userLanguage(account);
  const t = USAGE_TEXT[lang] || USAGE_TEXT[DEFAULT_LANGUAGE];
  const summary = await getUsageSummary(telegramId, days).catch((error) => {
    console.error('[usage] summary failed:', error.message);
    return null;
  });
  return usageSummaryView(summary, {
    lang,
    days,
    periodData: 'usage_',
    back: [{ text: t.logs, callback_data: 'logs' }, { text: t.back, callback_data: 'dashboard' }],
  });
}

async function adminUserUsageView(targetId, days) {
  const user = USER_ID_PATTERN.test(String(targetId)) ? await getUser(targetId) : null;
  if (!user) return null;
  const summary = await getUsageSummary(user.telegramId, days).catch(() => null);
  return usageSummaryView(summary, {
    lang: 'id',
    days,
    periodData: `admin_uu_${user.telegramId}_`,
    heading: `\u{1F464} <b>${escapeHtml(userDisplayName(user))}</b> <code>${escapeHtml(user.telegramId)}</code>`,
    back: [{ text: '\u{1F519} Detail user', callback_data: `admin_topup_user_${user.telegramId}` }],
  });
}

// ---------- Broadcast (announcements and polls) ----------
// Sends one message per user in the background, so the bot keeps answering everyone meanwhile.
// Telegram allows about 30 messages per second per bot; broadcasts use at most 20, leaving room
// for normal replies. A 429 pauses every sender for the retry_after Telegram asks for, and the
// message is retried. Users who blocked the bot or deleted their account are counted apart.
// One broadcast runs at a time; a second one waits for it. A restart stops a running broadcast.
const BROADCAST_INTERVAL_MS = 50; // 20 messages per second
const BROADCAST_WORKERS = 5;
const BROADCAST_MAX_ATTEMPTS = 4;
const BROADCAST_PROGRESS_MS = 3000;
const BROADCAST_ERRORS_KEPT = 3;
let broadcastNextSlot = 0;
let broadcastChain = Promise.resolve();
let broadcastsPending = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for this sender's turn under the shared rate limit.
async function broadcastSlot() {
  for (;;) {
    const now = Date.now();
    if (now >= broadcastNextSlot) {
      broadcastNextSlot = now + BROADCAST_INTERVAL_MS;
      return;
    }
    await sleep(broadcastNextSlot - now);
  }
}

function sendErrorKind(error) {
  const code = Number(error?.code) || 0;
  const text = String(error?.message || '');
  if (code === 429) return 'rate_limited';
  if (code === 403 || /bot was blocked|user is deactivated|bot was kicked/i.test(text)) return 'unreachable';
  if (code === 400 && /chat not found|user not found|peer_id_invalid/i.test(text)) return 'unreachable';
  if (!code || code >= 500) return 'transient';
  return 'failed';
}

// 'sent', 'unreachable' or { failed: error }.
async function deliverBroadcast(recipient, send) {
  for (let attempt = 1; ; attempt += 1) {
    await broadcastSlot();
    try {
      await send(recipient);
      return 'sent';
    } catch (error) {
      const kind = sendErrorKind(error);
      if (kind === 'unreachable') return 'unreachable';
      if (kind === 'failed' || attempt >= BROADCAST_MAX_ATTEMPTS) return { failed: error };
      if (kind === 'rate_limited') {
        // Flood control is per bot, so every sender waits.
        broadcastNextSlot = Math.max(broadcastNextSlot, Date.now() + (Number(error.retryAfter) || 5) * 1000 + 250);
      } else {
        await sleep(1000 * attempt);
      }
    }
  }
}

// Calls job.report(stats) one at a time, newest state each time; the final report always runs last.
function broadcastReporter(job, stats) {
  let chain = Promise.resolve();
  let busy = false;
  return (final = false) => {
    if (busy && !final) return chain;
    busy = true;
    const snapshot = { ...stats, errors: [...stats.errors] };
    chain = chain
      .then(() => job.report(snapshot))
      .catch((error) => console.error(`[broadcast] ${job.label}: status update failed: ${error.message}`))
      .then(() => { busy = false; });
    return chain;
  };
}

async function runBroadcast(job, stats, report) {
  stats.queued = false;
  stats.startedAt = Date.now();
  report();
  const progress = setInterval(() => report(), BROADCAST_PROGRESS_MS);
  let next = 0;
  const worker = async () => {
    while (next < job.recipients.length) {
      const recipient = job.recipients[next];
      next += 1;
      const outcome = await deliverBroadcast(recipient, job.send);
      if (outcome === 'sent') {
        stats.sent += 1;
      } else if (outcome === 'unreachable') {
        stats.unreachable += 1;
      } else {
        stats.failed += 1;
        const reason = clipChars(String(outcome.failed?.message || 'unknown error'), 120);
        if (stats.errors.length < BROADCAST_ERRORS_KEPT && !stats.errors.includes(reason)) stats.errors.push(reason);
        console.error(`[broadcast] ${job.label} -> ${recipient.telegramId}: ${reason}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(BROADCAST_WORKERS, Math.max(1, job.recipients.length)) }, worker));
  } finally {
    clearInterval(progress);
  }
  stats.done = true;
  stats.finishedAt = Date.now();
  console.log(`[broadcast] ${job.label}: ${stats.sent} sent, ${stats.unreachable} unreachable, ${stats.failed} failed of ${stats.total}`);
  await report(true);
}

// job = { label, recipients: [{ telegramId, ... }], send(recipient), report(stats) }. Returns at once.
function startBroadcast(job) {
  const stats = {
    total: job.recipients.length, sent: 0, unreachable: 0, failed: 0, errors: [],
    queued: broadcastsPending > 0, done: false, startedAt: null, finishedAt: null,
  };
  const report = broadcastReporter(job, stats);
  broadcastsPending += 1;
  report();
  broadcastChain = broadcastChain
    .then(() => runBroadcast(job, stats, report))
    .catch((error) => console.error(`[broadcast] ${job.label} stopped:`, error.message))
    .finally(() => { broadcastsPending -= 1; });
  return stats;
}

function broadcastDuration(stats) {
  const seconds = Math.max(0, Math.round(((stats.finishedAt || Date.now()) - (stats.startedAt || Date.now())) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

// Status text for the admin: progress while sending, the report when done. `title` is trusted HTML.
function broadcastStatusText(title, stats) {
  const processed = stats.sent + stats.unreachable + stats.failed;
  const percent = stats.total ? (processed / stats.total) * 100 : 100;
  const state = stats.done ? '\u{2705} done' : stats.queued ? '\u{23F3} waiting for the previous broadcast' : '\u{1F4E4} sending\u{2026}';
  return [
    `${title} \u{2014} ${state}`,
    `${progressBar(percent)} <b>${percent.toFixed(0)}%</b> (${formatTokens(processed)}/${formatTokens(stats.total)})`,
    '',
    `\u{2705} Delivered: <b>${formatTokens(stats.sent)}</b>`,
    `\u{1F6AB} Unreachable (blocked the bot / deleted account): <b>${formatTokens(stats.unreachable)}</b>`,
    `\u{274C} Failed: <b>${formatTokens(stats.failed)}</b>`,
    ...(stats.startedAt ? [`\u{23F1}\u{FE0F} ${broadcastDuration(stats)}`] : []),
    ...(stats.errors.length ? ['', '<i>Errors:</i>', ...stats.errors.map((reason) => `\u{2022} <code>${escapeHtml(reason)}</code>`)] : []),
    ...(stats.done ? [] : ['', '<i>The bot keeps working normally while this runs.</i>']),
  ].join('\n');
}

// Edits a status message; progress edits that fail are only logged (never a new message).
async function editStatusMessage(chatId, messageId, text, replyMarkup) {
  try {
    await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  } catch (error) {
    if (!/message is not modified/i.test(error.message)) throw error;
  }
}

async function adminPanelMessage() {
  const settings = await readSettings();
  const s = await getAdminStats();
  const referral = await getReferralSettings();
  const updatedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const openTickets = await countOpenTickets();
  const onOff = (on, onText = 'ON', offText = 'OFF') => (on ? `\u{1F7E2} ${onText}` : `\u{1F534} ${offText}`);
  const disabledFamilies = (settings.disabledFamilies || []).length;
  const disabledModels = (settings.disabledModels || []).length;
  // Null when the API server has no BANSOS support yet (outdated files there).
  const bansos = await listBansos().catch(() => null);
  const bansosCount = (status) => bansos.filter((entry) => entry.status === status).length;
  // Null when the API server has no token credits yet.
  const credit = await getCreditStats().catch(() => null);
  return [
    '\u{1F6E0}\u{FE0F} <b>ADMIN DASHBOARD</b>',
    `<i>${escapeHtml(STORE_NAME)} \u{2022} control center</i>`,
    DIVIDER,
    `\u{1F465} <b>${formatTokens(s.totalUsers)}</b> users  \u{2022}  \u{1F4E1} <b>${shortNumber(s.requests)}</b> req  \u{2022}  \u{1F4B0} <b>${rupiah(s.revenue)}</b>`,
    `\u{1F3AB} Open tickets: <b>${formatTokens(openTickets)}</b>${openTickets ? '  \u{2757}' : ''}`,
    '',
    card('\u{1F465} <b>Users</b>', [
      `Total: <b>${formatTokens(s.totalUsers)}</b>  (+${formatTokens(s.newUsers24h)} in 24h)`,
      `Active: <b>${formatTokens(s.activeUsers)}</b>`,
      `Active API keys: <b>${formatTokens(s.activeKeys)}</b>`,
    ]),
    card('\u{1F4E1} <b>Requests</b>', [
      `Total: <b>${formatTokens(s.requests)}</b>`,
      `\u{2705} Success: <b>${formatTokens(s.success)}</b>  \u{2022}  \u{274C} Error: <b>${formatTokens(s.errors)}</b>`,
      `${progressBar(s.successRate)} <b>${s.successRate.toFixed(1)}%</b>`,
      `Last 24h: <b>${formatTokens(s.last24h.requests)}</b> req \u{2022} ${formatTokens(s.last24h.errors)} err \u{2022} avg ${formatTokens(s.last24h.avgMs)} ms`,
    ]),
    card('\u{1F522} <b>Tokens</b>', [
      `\u{1F4E5} Input: <b>${bigNumber(s.inputTokens)}</b>`,
      `\u{1F4E4} Output: <b>${bigNumber(s.outputTokens)}</b>`,
      `\u{1F9EE} Total: <b>${bigNumber(s.totalTokens)}</b>`,
    ]),
    card('\u{1F4B0} <b>Finance</b>', [
      `Usage billed: <b>${formatCost(s.spent)}</b>`,
      `Paid top-ups: <b>${rupiah(s.revenue)}</b>  (${formatTokens(s.settledOrders)} settled \u{2022} ${formatTokens(s.pendingOrders)} pending)`,
      `Redeemed codes: <b>${rupiah(s.redeemedAmount)}</b>  (${formatTokens(s.redemptions)}x)`,
      `Users' total balance: <b>${rupiah(s.totalBalance)}</b>`,
    ]),
    ...(credit ? [card('\u{1F48E} <b>Token credits</b>', [
      `Sold: <b>${bigNumber(credit.purchased)}</b> \u{2022} used: <b>${bigNumber(credit.used)}</b>`,
      `Outstanding: <b>${bigNumber(credit.totalBalance)}</b> \u{2022} reserved: ${bigNumber(credit.totalReserved)}`,
      `Revenue: <b>${rupiah(credit.revenueIdr)}</b> (${formatTokens(credit.settledOrders)} paid \u{2022} ${formatTokens(credit.pendingOrders)} pending) \u{2022} unlimited active: ${formatTokens(credit.activePasses)}`,
    ])] : []),
    card('\u{1F39F}\u{FE0F} <b>Redeem Codes</b>', [
      `Created: <b>${formatTokens(s.redeemCodes)}</b>  \u{2022}  Still active: <b>${formatTokens(s.activeRedeemCodes)}</b>`,
      // Missing on an API server without model access codes yet.
      s.accessCodes !== undefined
        && `\u{1F510} Model access: <b>${formatTokens(s.accessCodes)}</b> created \u{2022} <b>${formatTokens(s.accessCodesAvailable)}</b> unused \u{2022} <b>${formatTokens(s.accessCodesInUse)}</b> running`,
    ]),
    card('\u{1F91D} <b>Referral</b>', [
      `Status: <b>${onOff(referral.enabled)}</b>  \u{2022}  Reward: <b>${shortNumber(referral.rewardTokens)}</b> token/invite`,
      `Invites: <b>${formatTokens(s.referralInvites || 0)}</b>  (rewarded ${formatTokens(s.referralRewarded || 0)})`,
      `Tokens awarded: <b>${bigNumber(s.referralTokensAwarded || 0)}</b>`,
      `Unused bonus: <b>${bigNumber(s.bonusTokensLeft || 0)}</b>`,
    ]),
    card('\u{2699}\u{FE0F} <b>Settings</b>', [
      `Free mode: <b>${onOff(settings.allModelsFree)}</b>`,
      `Payments (top up): <b>${onOff(settings.paymentsEnabled !== false, 'OPEN', 'CLOSED')}</b>`,
      `Disabled: <b>${formatTokens(disabledFamilies)}</b> family \u{2022} <b>${formatTokens(disabledModels)}</b> model`,
      bansos && `BANSOS: <b>${formatTokens(bansosCount('active'))}</b> active \u{2022} <b>${formatTokens(bansosCount('scheduled'))}</b> scheduled`,
      `Last announcement: ${settings.announcement ? `<i>${escapeHtml(settings.announcement.slice(0, 80))}</i>` : '<b>None</b>'}`,
    ]),
    DIVIDER,
    s.statsResetAt
      ? `<i>\u{267B}\u{FE0F} Stats since ${escapeHtml(wibTime(s.statsResetAt))} (last reset)</i>`
      : '<i>\u{267B}\u{FE0F} Stats counted since the beginning</i>',
    `<i>\u{1F552} Updated ${escapeHtml(updatedAt)} WIB</i>`,
  ].join('\n');
}

function topUpKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{1F4B5} Rp10.000', callback_data: 'topup_10000' }, { text: '\u{1F4B5} Rp25.000', callback_data: 'topup_25000' }],
    [{ text: '\u{1F4B5} Rp50.000', callback_data: 'topup_50000' }, { text: '\u{1F4B5} Rp100.000', callback_data: 'topup_100000' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

// --- Language preference -------------------------------------------------
// Picked once on the first /start and stored on the user record (`language`).
// Users without a saved choice keep the original Indonesian texts.
const DEFAULT_LANGUAGE = 'id';
// Referral greeting for a brand-new user, held until they pick a language so
// the language picker is the first thing they see. Inviter is notified at once.
const pendingReferralGreeting = new Map();

function hasLanguage(account) {
  return account?.language === 'en' || account?.language === 'id';
}

function userLanguage(account) {
  return hasLanguage(account) ? account.language : DEFAULT_LANGUAGE;
}

function languagePickerMessage() {
  return [
    `\u{1F6CD}\u{FE0F} <b>${escapeHtml(STORE_NAME.toUpperCase())}</b>`,
    DIVIDER,
    '\u{1F44B} <b>Welcome!</b> / <b>Selamat datang!</b>',
    '',
    '\u{1F310} Please choose your language.',
    '\u{1F310} Silakan pilih bahasa kamu.',
  ].join('\n');
}

function languageKeyboard() {
  return { inline_keyboard: [[
    { text: '\u{1F1EC}\u{1F1E7} English', callback_data: 'lang_en' },
    { text: '\u{1F1EE}\u{1F1E9} Indonesia', callback_data: 'lang_id' },
  ]] };
}

async function sendWelcome(chatId, from) {
  const userId = String(from.id || chatId);
  await telegram('sendMessage', { chat_id: chatId, text: await welcomeMessage(from.first_name, userId), parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
}

async function handleLanguageChoice(query, lang) {
  const chatId = query.message.chat.id;
  const from = query.from;
  const userId = String(from.id);
  await setUserLanguage(userId, lang, { firstName: from.first_name, username: from.username });
  const confirmation = lang === 'en' ? '\u{2705} Language set to <b>English</b>.' : '\u{2705} Bahasa diatur ke <b>Indonesia</b>.';
  // Replace the picker so its buttons cannot be pressed again.
  await telegram('editMessageText', { chat_id: chatId, message_id: query.message.message_id, text: confirmation, parse_mode: 'HTML' }).catch(() => {});
  await sendWelcome(chatId, from);
  const referral = pendingReferralGreeting.get(userId);
  pendingReferralGreeting.delete(userId);
  await greetReferredUser(chatId, referral, lang);
}

async function welcomeMessage(firstName, telegramId) {
  const account = telegramId ? await getUser(telegramId) : null;
  // An API server without token credits yet simply shows none.
  const creditAccount = telegramId ? (await getCreditOverview(telegramId).catch(() => null))?.account : null;
  const balance = Number(account?.balance || 0);
  const bonusTokens = Number(account?.bonusTokens || 0);
  const activeKeys = (account?.apiKeys || []).filter((entry) => entry.active !== false).length;
  if (userLanguage(account) === 'en') {
    return [
      `\u{1F6CD}\u{FE0F} <b>${escapeHtml(STORE_NAME.toUpperCase())}</b>`,
      DIVIDER,
      `\u{1F44B} Hello, <b>${escapeHtml(firstName || 'there')}</b>! \u{2728}`,
      '\u{1F511} Get everything you need for <b>API Tokens</b> right here.',
      '\u{26A1} Fast \u{2022} \u{1F4B8} Affordable \u{2022} \u{2705} Instantly active',
      '',
      card('\u{1F464} <b>Your account</b>', [
        ...(telegramId ? [`\u{1F194} ID: <code>${escapeHtml(telegramId)}</code>`] : []),
        creditAccount ? `\u{1F48E} Token credits: <b>${bigNumber(creditAccount.available)}</b>` : '',
        (balance > 0 || !creditAccount) ? `\u{1F4B0} Balance: <b>${rupiah(balance)}</b>${creditAccount ? ' <i>(old Rupiah balance)</i>' : ''}` : '',
        bonusTokens > 0 ? `\u{1F381} Bonus tokens: <b>${bigNumber(bonusTokens)}</b>` : '',
        `\u{1F511} Active API keys: <b>${formatTokens(activeKeys)}</b>`,
      ]),
      '',
      '\u{1F447} <b>Choose a menu below to get started:</b>',
    ].join('\n');
  }
  return [
    `\u{1F6CD}\u{FE0F} <b>${escapeHtml(STORE_NAME.toUpperCase())}</b>`,
    DIVIDER,
    `\u{1F44B} Halo, <b>${escapeHtml(firstName || 'there')}</b>! \u{2728}`,
    '\u{1F511} Belanja kebutuhan <b>API Token</b> di sini aja.',
    '\u{26A1} Cepat \u{2022} \u{1F4B8} Hemat \u{2022} \u{2705} Langsung aktif',
    '',
    card('\u{1F464} <b>Akun kamu</b>', [
      ...(telegramId ? [`\u{1F194} ID: <code>${escapeHtml(telegramId)}</code>`] : []),
      creditAccount ? `\u{1F48E} Kredit token: <b>${bigNumber(creditAccount.available)}</b>` : '',
      (balance > 0 || !creditAccount) ? `\u{1F4B0} Saldo: <b>${rupiah(balance)}</b>${creditAccount ? ' <i>(saldo Rupiah lama)</i>' : ''}` : '',
      bonusTokens > 0 ? `\u{1F381} Bonus token: <b>${bigNumber(bonusTokens)}</b>` : '',
      `\u{1F511} API key aktif: <b>${formatTokens(activeKeys)}</b>`,
    ]),
    '',
    '\u{1F447} <b>Pilih menu di bawah untuk mulai:</b>',
  ].join('\n');
}

async function statsMessage(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return 'No account found. Send /start first.';
  const activeKeys = user.apiKeys.filter((entry) => entry.active !== false);
  const stats = user.stats || {};
  const requests = Number(stats.requests || 0);
  const errors = Number(stats.errors || 0);
  const successRate = requests ? ((requests - errors) / requests) * 100 : 0;
  const bonusTokens = Number(user.bonusTokens || 0);
  const keyLines = activeKeys.length
    ? activeKeys.map((entry, index) => `\u{1F511} Key ${index + 1}: <code>${escapeHtml(entry.key)}</code>`)
    : ['\u{1F511} API key: <i>belum ada \u{2014} tekan "Create new API key"</i>'];
  // An API server without model access codes yet simply has none.
  const accessCard = modelAccessCard(await getModelAccess(telegramId).catch(() => null), userLanguage(user));
  const credit = await getCreditOverview(telegramId).catch(() => null);
  const activePass = credit?.passes?.active?.[0];
  // With token credits, the old Rupiah card and spend line only show for users who still have them.
  const showRupiah = !credit || Number(user.balance || 0) > 0 || bonusTokens > 0;
  const spent = Number(stats.spent || 0);
  return [
    '\u{1F4CA} <b>API DASHBOARD</b>',
    DIVIDER,
    card('\u{1F510} <b>API Access</b>', [
      `\u{1F4E1} Base URL: <code>${escapeHtml(PUBLIC_BASE_URL)}</code>`,
      ...keyLines,
    ]),
    ...(credit ? [card('\u{1F48E} <b>Kredit token</b>', [
      `Tersedia: <b>${bigNumber(credit.account.available)}</b> kredit`,
      credit.account.reserved > 0 && `Sedang direservasi: <b>${bigNumber(credit.account.reserved)}</b> kredit`,
      activePass && `\u{267E}\u{FE0F} ${escapeHtml(activePass.name || 'Unlimited')} aktif s/d <b>${escapeHtml(wibTime(activePass.endsAt))}</b>`,
    ])] : []),
    ...(showRupiah ? [card('\u{1F4B3} <b>Balance</b>', [
      `\u{1F4B0} Saldo: <b>${rupiah(user.balance)}</b>${credit ? ' <i>(saldo Rupiah lama, terpisah dari kredit)</i>' : ''}`,
      `\u{1F381} Bonus tokens: <b>${bigNumber(bonusTokens)}</b>${bonusTokens > 0 ? ' <i>(dipakai duluan)</i>' : ''}`,
    ])] : []),
    ...(accessCard ? [accessCard] : []),
    card('\u{1F4C8} <b>Usage</b>', [
      `\u{1F4E8} Requests: <b>${formatTokens(requests)}</b>  (\u{26A0}\u{FE0F} ${formatTokens(errors)} error)`,
      requests ? `${progressBar(successRate)} <b>${successRate.toFixed(1)}%</b> success` : '',
      `\u{1F4E5} Input tokens: <b>${bigNumber(stats.inputTokens)}</b>`,
      `\u{1F4E4} Output tokens: <b>${bigNumber(stats.outputTokens)}</b>`,
      `\u{1F9EE} Total tokens: <b>${bigNumber(stats.totalTokens)}</b>`,
      (!credit || spent > 0) && `\u{1F4B8} Spent: <b>${formatCost(stats.spent)}</b>${credit ? ' <i>(saldo Rupiah lama)</i>' : ''}`,
      `\u{1F552} Last used: <b>${escapeHtml(wibTime(user.lastUsedAt))}</b>`,
    ]),
    '',
    '\u{26A1} <b>Quick start</b> (OpenAI-compatible)',
    `<pre>base_url = "${escapeHtml(PUBLIC_BASE_URL)}"\napi_key  = "${escapeHtml(activeKeys[0]?.key || 'sk-user-...')}"</pre>`,
    '<i>Tap key / URL untuk copy.</i>',
  ].join('\n');
}

const MODEL_FAMILIES = ['Groq', 'Qwen', 'ChatGPT', 'Hy', 'DeepSeek', 'GLM', 'Kimi', 'Gemini', 'MiniMax', 'Claude'];
// Last synced supported model names (display names), used by the admin Disable Model menu.
let supportedModelsCache = [];

// Fetches the upstream model list, stores the route aliases where server.js reads
// them, and returns the supported display names sorted alphabetically.
async function syncSupportedModels() {
  const response = await fetch(`${UPSTREAM_BASE_URL}/models`, {
    headers: UPSTREAM_API_KEY ? { Authorization: `Bearer ${UPSTREAM_API_KEY}` } : {},
  });
  const result = await response.json();
  if (!response.ok || !Array.isArray(result.data)) throw new Error(result.error?.message || `Upstream returned ${response.status}`);
  const aliases = {};
  for (const model of result.data.map((entry) => entry.id).filter(Boolean)) {
    const displayName = stripModelPrefix(model);
    // Prefer the 1/ upstream route when several route prefixes expose the same name.
    if (!aliases[displayName] || model.startsWith('1/')) aliases[displayName] = model;
  }
  // Keep pinned models listed when the upstream response leaves them out.
  for (const [displayName, route] of Object.entries(PINNED_MODELS)) {
    if (!aliases[displayName]) aliases[displayName] = route;
  }
  const models = Object.keys(aliases).filter((model) => getModelFamily(model)).sort();
  // Stored where server.js reads it (on the API server when the hosts are split).
  await saveModelCache({ syncedAt: new Date().toISOString(), models, aliases });
  supportedModelsCache = models;
  return models;
}

function isDisabledIn(disabled, model) {
  return disabled.models.includes(model.toLowerCase()) || disabled.families.includes(getModelFamily(model));
}

// `telegramId` (optional): the asking user, so an active model access code can be pointed out.
async function modelPriceMessage(telegramId) {
  const access = telegramId ? await getModelAccess(telegramId).catch(() => null) : null;
  const account = access?.granted ? await getUser(telegramId).catch(() => null) : null;
  const notice = access?.granted ? `${modelAccessNotice(access, userLanguage(account))}\n\n` : '';
  const unlocked = new Set(access?.granted ? access.models : []);
  const disabled = await getDisabledModels();
  // Users only see models they can actually use: disabled ones only while their access code unlocks them.
  const models = (await syncSupportedModels()).filter((model) => !isDisabledIn(disabled, model) || unlocked.has(model.toLowerCase()));
  const allFree = await isAllModelsFree();
  // Active BANSOS windows; an outdated API server simply has none.
  const bansos = allFree ? [] : (await listBansos().catch(() => [])).filter((entry) => entry.status === 'active');
  const families = MODEL_FAMILIES;
  const sections = families.map((family) => {
    const familyModels = models.filter((model) => getModelFamily(model) === family);
    if (!familyModels.length) return '';
    const lines = familyModels.map((model) => {
      const freeWindow = bansosWindowFor(bansos, model);
      if (freeWindow) return `• <code>${escapeHtml(model)}</code> — \u{1F381} Gratis (BANSOS)\n  ↳ Sampai ${escapeHtml(wibTime(freeWindow.endsAt))}`;
      const price = allFree ? 0 : getModelPrice(model);
      if (price === 0) return `• <code>${escapeHtml(model)}</code> — Gratis\n  ↳ Saldo Rp10rb ≈ Unlimited (Gratis)`;
      const appliedPrice = price ?? DEFAULT_MODEL_PRICE;
      const label = price === null ? ' (default)' : '';
      const allowance = tokenAllowance(appliedPrice, 10000);
      return `• <code>${escapeHtml(model)}</code> — Rp${appliedPrice.toLocaleString('id-ID')} / 1M token${label}\n  ↳ Saldo Rp10rb ≈ ±${(allowance / 1_000_000).toFixed(1)} juta token`;
    });
    return `<b>${family} Family</b>\n${lines.join('\n')}`;
  }).filter(Boolean);
  return `${notice}\u{1F4B0} <b>Model Price</b>\n<i>Harga per 1M token untuk saldo Rupiah lama. Kredit token memakai multiplier: lihat \u{1F4CB} Model &amp; Multiplier.</i>\n\n${sections.length ? sections.join('\n\n') : 'No supported models returned by upstream.'}`;
}

function revokeKeyboard(user) {
  const activeKeys = (user?.apiKeys || []).filter((entry) => entry.active !== false);
  const rows = activeKeys.map((entry, index) => [{ text: `\u{1F5D1}\u{FE0F} Revoke key ${index + 1}`, callback_data: `revoke_${index}` }]);
  rows.push([{ text: '\u{1F519} Back to dashboard', callback_data: 'dashboard' }]);
  return { inline_keyboard: rows };
}

// Explicitly select QRIS Custom; omitting kode_channel uses Cashi's default QRIS.
// Throws when Cashi refuses; never retry through the default channel.
async function cashiCreatePayment(orderId, amount) {
  const response = await fetch(CASHI_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CASHI_API_KEY },
    body: JSON.stringify({ amount, order_id: orderId, kode_channel: 'qris_custom' }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.message || `Cashi returned ${response.status}`);
  return result;
}

async function sendCashiQr(chatId, result, caption, orderId) {
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
  await telegram('sendMessage', { chat_id: chatId, text: 'After payment, press Refresh status to check your payment. \u{1F4CA}\nSetelah membayar, tekan Refresh status.', reply_markup: { inline_keyboard: [[{ text: '\u{1F504} Refresh status', callback_data: `status_${orderId}` }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] } });
}

// Old Rupiah balance top-up (unchanged behaviour).
async function createCashiOrder(chatId, telegramId, amount) {
  if (!CASHI_API_KEY) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{26A0}\u{FE0F} Cashi payments are not configured yet. Add CASHI_API_KEY to .env.' });
    return;
  }
  const orderId = `TG-${telegramId}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  try {
    const result = await cashiCreatePayment(orderId, amount);
    await createOrder(telegramId, { orderId, amount, checkoutUrl: result.checkout_url, provider: result.provider || 'CASHI' });
    const caption = `\u{2705} <b>Payment QR ready</b>\n\nAmount: <b>Rp${amount.toLocaleString('id-ID')}</b>\nOrder: <code>${orderId}</code>\n\nScan this QR to pay. Your balance will update automatically after Cashi confirms payment.`;
    await sendCashiQr(chatId, result, caption, orderId);
  } catch (error) {
    console.error('[cashi]', error.message);
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not create the payment: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: menuKeyboard() });
  }
}

// Token credit package or unlimited package. The API server creates the order first (price and
// content from ITS configuration), then Cashi is asked for that exact amount. Credits are added
// only when the payment is verified (webhook or Refresh status) for that order and amount.
async function startCreditPurchase(chatId, telegramId, request) {
  if (!CASHI_API_KEY) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{26A0}\u{FE0F} Pembayaran Cashi belum dikonfigurasi (CASHI_API_KEY kosong).', reply_markup: menuKeyboard(telegramId) });
    return;
  }
  let order;
  try {
    order = await createCreditOrder(telegramId, request);
  } catch (error) {
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Kredit Token', callback_data: 'credits' }]] } });
    return;
  }
  let result;
  try {
    result = await cashiCreatePayment(order.orderId, order.priceIdr);
  } catch (error) {
    console.error('[cashi]', error.message);
    await markCreditOrderFailed(order.orderId, error.message).catch(() => {});
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Pembayaran gagal dibuat: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: menuKeyboard(telegramId) });
    return;
  }
  const what = order.kind === 'credits'
    ? `Paket: <b>${bigNumber(order.credits)} kredit token</b>`
    : `Paket: <b>${escapeHtml(order.name || 'Unlimited')} ${unlimitedDurationLabel(order.hours)}</b>`;
  const caption = [
    '\u{2705} <b>QR pembayaran siap</b>',
    '',
    what,
    `Harga: <b>${rupiah(order.priceIdr)}</b>`,
    `Order: <code>${escapeHtml(order.orderId)}</code>`,
    '',
    order.kind === 'credits'
      ? 'Scan QR untuk membayar. Kredit masuk otomatis setelah pembayaran terverifikasi.'
      : 'Scan QR untuk membayar. Paket aktif setelah pembayaran terverifikasi.',
  ].join('\n');
  try {
    await sendCashiQr(chatId, result, caption, order.orderId);
  } catch (error) {
    // The Cashi order exists: keep it payable and tell the user how to continue.
    console.error('[cashi qr]', error.message);
    const link = result.checkout_url ? `\n\nBuka link pembayaran: ${escapeHtml(result.checkout_url)}` : '';
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{26A0}\u{FE0F} QR tidak bisa ditampilkan (${escapeHtml(error.message)}).${link}\nOrder: <code>${escapeHtml(order.orderId)}</code>`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F504} Refresh status', callback_data: `status_${order.orderId}` }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] },
    });
  }
}

const PAYMENT_PROBLEMS = {
  amount_mismatch: '\u{26A0}\u{FE0F} Jumlah yang dibayar tidak sesuai harga paket, jadi kredit belum ditambahkan. Hubungi admin lewat ticket dengan menyertakan nomor order.',
  amount_missing: '\u{23F3} Pembayaran tercatat lunas, tetapi nominal belum tersedia dari Cashi. Tekan Refresh status untuk mencoba lagi, atau hubungi admin lewat ticket.',
};

async function refreshCashiStatus(chatId, telegramId, orderId) {
  if (!CASHI_API_KEY) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{26A0}\u{FE0F} Cashi payments are not configured yet.' });
    return;
  }
  const creditOrder = await getCreditOrder(telegramId, orderId).catch(() => null);
  const order = creditOrder || await getOrder(telegramId, orderId);
  if (!order) {
    await telegram('sendMessage', { chat_id: chatId, text: '\u{274C} Payment order not found.', reply_markup: menuKeyboard() });
    return;
  }
  const refreshMarkup = { inline_keyboard: [[{ text: '\u{1F504} Refresh status', callback_data: `status_${orderId}` }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] };
  try {
    const result = await getCashiPaymentStatus(orderId);
    const status = result.status;
    if (creditOrder) {
      if (status !== 'SETTLED' && creditOrder.status !== 'SETTLED') {
        await telegram('sendMessage', { chat_id: chatId, text: `\u{23F3} <b>Status pembayaran: ${escapeHtml(status)}</b>\n\nOrder: <code>${escapeHtml(orderId)}</code>\nSelesaikan pembayaran QR, lalu tekan Refresh lagi.`, parse_mode: 'HTML', reply_markup: refreshMarkup });
        return;
      }
      // Verified with Cashi just now (status and amount of THIS order id); credited at most once.
      const settled = creditOrder.status === 'SETTLED' ? { alreadySettled: true } : await settlePayment(orderId, result.amount, status, { source: 'bot_refresh' });
      if (settled?.reason && PAYMENT_PROBLEMS[settled.reason]) {
        const amount = result.amount === undefined ? 'Belum tersedia' : rupiah(result.amount);
        await telegram('sendMessage', { chat_id: chatId, text: `${PAYMENT_PROBLEMS[settled.reason]}\n\nHarga paket: <b>${rupiah(creditOrder.priceIdr)}</b>\nJumlah dari Cashi: <b>${amount}</b>\nOrder: <code>${escapeHtml(orderId)}</code>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [refreshMarkup.inline_keyboard[0], [{ text: '\u{1F3AB} Create a Ticket', callback_data: 'ticket' }], refreshMarkup.inline_keyboard[1]] } });
        return;
      }
      if (!settled?.settled && !settled?.alreadySettled) throw new Error('Pembayaran belum berhasil diverifikasi. Silakan Refresh status lagi.');
      const overview = await getCreditOverview(telegramId).catch(() => null);
      const pass = settled.pass || [...(overview?.passes?.active || []), ...(overview?.passes?.scheduled || [])].find(item => item.orderId === orderId);
      const scheduled = pass && Date.parse(pass.startsAt) > Date.now();
      const lines = creditOrder.kind === 'credits'
        ? [`\u{2705} <b>Pembayaran terverifikasi!</b>`, '', `+<b>${bigNumber(creditOrder.credits)}</b> kredit token`, `Saldo kredit: <b>${bigNumber(overview?.account.available ?? 0)}</b>`]
        : [`\u{2705} <b>Paket unlimited ${scheduled ? 'terjadwal' : 'aktif'}!</b>`, '', pass ? `Berlaku: <b>${escapeHtml(wibTime(pass.startsAt))}</b> s/d <b>${escapeHtml(wibTime(pass.endsAt))}</b>` : ''];
      const paidAmount = creditOrder.paidAmount ?? result.amount;
      await telegram('sendMessage', { chat_id: chatId, text: [...lines, paidAmount !== undefined ? `Jumlah dibayar: <b>${rupiah(paidAmount)}</b>` : '', `Order: <code>${escapeHtml(orderId)}</code>`].filter(Boolean).join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F48E} Kredit Token', callback_data: 'credits' }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] } });
      return;
    }
    if (status === 'SETTLED') await settleOrder(orderId, result.amount);
    const updated = await getUser(telegramId);
    const balance = Number(updated?.balance || 0).toLocaleString('id-ID');
    await telegram('sendMessage', {
      chat_id: chatId,
      text: status === 'SETTLED'
        ? `\u{2705} <b>Payment settled!</b>\n\nOrder: <code>${escapeHtml(orderId)}</code>\nBalance: <b>Rp${balance}</b>`
        : `\u{23F3} <b>Payment status: ${escapeHtml(status)}</b>\n\nOrder: <code>${escapeHtml(orderId)}</code>\nComplete the QR payment, then refresh again.`,
      parse_mode: 'HTML',
      reply_markup: status === 'SETTLED' ? menuKeyboard() : refreshMarkup,
    });
  } catch (error) {
    console.error('[cashi status]', error.message);
    await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not check payment status: ${escapeHtml(error.message)}\n\nOrder: <code>${escapeHtml(orderId)}</code>`, parse_mode: 'HTML', reply_markup: refreshMarkup });
  }
}

// ---------- Token credits (menu: Kredit Token, /kredit; Admin Panel -> Kredit & Paket) ----------
// Everything here reads the API server's credit store and configuration (credit-store.js,
// credit-config.js). Credits are a separate balance from the old Rupiah saldo. Paid models are
// never shown as free: a model without a rate shows "menunggu konfigurasi".
const CREDIT_HISTORY_SHOWN = 15;
const CREDIT_UNAVAILABLE = '\u{26A0}\u{FE0F} Fitur kredit token belum aktif di server. Upload credit-rules.js, credit-config.js, credit-store.js, server.js dan usage-db.js terbaru ke server API, lalu restart.';

function multiplierText(value) {
  return `\u{00D7}${String(value).replace('.', ',')}`;
}

// About how many tokens `credits` buys at multiplier `value` ("1.75").
function tokensAt(credits, value) {
  try {
    return creditRules.tokensForCredits(credits, creditRules.parseMultiplier(value));
  } catch (_) {
    return 0;
  }
}

function creditBackRow() {
  return [{ text: '\u{1F519} Kredit Token', callback_data: 'credits' }, { text: '\u{1F3E0} Menu', callback_data: 'menu' }];
}

function shortTime(iso) {
  const time = wibLogTime(iso);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(time) ? `${time.slice(8, 10)}/${time.slice(5, 7)} ${time.slice(11, 16)}` : time;
}

function unlimitedDurationLabel(hours) {
  return Number(hours) >= 24 && Number(hours) % 24 === 0 ? `${formatTokens(Number(hours) / 24)} hari` : `${formatTokens(hours)} jam`;
}

function unlimitedTerms(source) {
  const limits = source.limits || {};
  return [
    `Model yang termasuk: ${source.models?.length ? source.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(', ') : '<i>belum ada</i>'}`,
    `Maks <b>${formatTokens(limits.maxConcurrent)}</b> request bersamaan, <b>${formatTokens(limits.rpm)}</b> request/menit`,
    `Output maks <b>${formatTokens(limits.maxOutputTokens)}</b> token per request`,
    'Model yang tercakup tidak memotong kredit selama paket aktif',
    'Model lain tetap memakai kredit token seperti biasa',
  ];
}

async function creditMainView(telegramId) {
  const [overview, catalog] = await Promise.all([getCreditOverview(telegramId), getCreditCatalog()]);
  const { account, legacy, passes } = overview;
  const basis = account.available > 0 ? account.available : (catalog.packages.find((item) => item.active)?.credits || 10_000_000);
  // One example model per distinct multiplier, lowest first.
  const examples = new Map();
  for (const entry of catalog.models) {
    if (entry.status === 'active' && entry.listed && !examples.has(entry.multiplier)) examples.set(entry.multiplier, entry);
  }
  const exampleLines = [...examples.values()]
    .sort((a, b) => a.multiplierUnits - b.multiplierUnits)
    .map((entry) => `${multiplierText(entry.multiplier)} \u{2248} <b>${shortNumber(tokensAt(basis, entry.multiplier))}</b> token <i>(mis. ${escapeHtml(entry.model)})</i>`);
  const lines = [
    '\u{1F48E} <b>KREDIT TOKEN</b>',
    DIVIDER,
    card('\u{1F4B3} <b>Saldo kredit</b>', [
      `Tersedia: <b>${bigNumber(account.available)}</b> kredit`,
      `Sedang direservasi: <b>${bigNumber(account.reserved)}</b> kredit${account.reserved > 0 ? ' <i>(request yang sedang berjalan)</i>' : ''}`,
      account.purchased > 0 && `Total dibeli: ${bigNumber(account.purchased)} \u{2022} terpakai: ${bigNumber(account.used)}`,
    ]),
  ];
  for (const pass of [...passes.active, ...passes.scheduled].slice(0, 2)) {
    lines.push(card(`\u{267E}\u{FE0F} <b>${escapeHtml(pass.name || 'Unlimited')}</b> ${pass.status === 'active' ? '(aktif)' : '(menunggu mulai)'}`, [
      `${escapeHtml(wibTime(pass.startsAt))} \u{2192} <b>${escapeHtml(wibTime(pass.endsAt))}</b>`,
      `Model: ${pass.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(', ')}`,
    ]));
  }
  if (legacy.balance > 0 || legacy.bonusTokens > 0) {
    lines.push(card('\u{1F4B0} <b>Saldo lama (terpisah)</b>', [
      legacy.balance > 0 && `Saldo Rupiah: <b>${rupiah(legacy.balance)}</b>`,
      legacy.bonusTokens > 0 && `Bonus token: <b>${bigNumber(legacy.bonusTokens)}</b>`,
      'Belum dikonversi ke kredit. Dipakai dengan harga lama bila kredit kamu habis.',
    ]));
  }
  lines.push(
    '',
    '\u{2139}\u{FE0F} <b>Cara kerja kredit token</b>',
    'Kredit terpakai = (token input + token output) \u{00D7} multiplier model.',
    '1 kredit = 1 token di model \u{00D7}1. Jumlah token yang benar-benar bisa kamu pakai = kredit \u{00F7} multiplier.',
    'Contoh: 100.000 token di <code>glm-5.2</code> (\u{00D7}1,75) = 175.000 kredit.',
    '',
    `\u{1F4CA} <b>Estimasi dari ${account.available > 0 ? 'saldo kamu' : `paket ${shortNumber(basis)} kredit`}</b>`,
    ...(exampleLines.length ? exampleLines : ['<i>Belum ada model dengan tarif aktif.</i>']),
    '',
    '<i>Kredit tidak kedaluwarsa. Request kecil membayar sesuai pemakaiannya saja.</i>',
  );
  const rows = [
    [{ text: BUY_CREDITS_BUTTON, callback_data: 'top_up' }, { text: '\u{1F4CB} Model & multiplier', callback_data: 'cr_models' }],
    [{ text: '\u{1F9FE} Riwayat kredit', callback_data: 'cr_hist' }, { text: '\u{267E}\u{FE0F} Paket Unlimited', callback_data: 'cr_ul' }],
    [{ text: '\u{1F504} Refresh', callback_data: 'credits' }, { text: '\u{1F3E0} Menu', callback_data: 'menu' }],
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function creditBuyView() {
  const catalog = await getCreditCatalog();
  const packages = catalog.packages.filter((item) => item.active);
  const lines = ['\u{1F6D2} <b>BELI KREDIT TOKEN</b>', DIVIDER];
  const rows = [];
  if (!catalog.billing.creditSalesEnabled || !packages.length) {
    lines.push('Penjualan kredit sedang ditutup. Silakan coba lagi nanti.');
  } else {
    lines.push('Pilih paket. Kredit masuk otomatis setelah pembayaran terverifikasi dan <b>tidak kedaluwarsa</b>.', '');
    for (const item of packages) {
      lines.push(`\u{1F48E} <b>${bigNumber(item.credits)} kredit</b> \u{2014} <b>${rupiah(item.priceIdr)}</b>`,
        `   \u{2248} ${shortNumber(tokensAt(item.credits, '1'))} token di model \u{00D7}1 \u{2022} \u{2248} ${shortNumber(tokensAt(item.credits, '1.75'))} token di \u{00D7}1,75`);
      rows.push([{ text: `\u{1F48E} ${shortNumber(item.credits)} kredit \u{2022} ${rupiah(item.priceIdr)}`, callback_data: `crbuy_${item.id}` }]);
    }
    lines.push('', '<i>Token aktual tergantung multiplier model yang kamu pakai.</i>');
  }
  if (catalog.unlimited.saleEnabled) rows.push([{ text: `\u{267E}\u{FE0F} ${catalog.unlimited.name}`, callback_data: 'cr_ul' }]);
  if (catalog.billing.legacyTopupEnabled) rows.push([{ text: '\u{1F4B5} Top up saldo Rupiah (lama)', callback_data: 'top_up_rp' }]);
  rows.push(creditBackRow());
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function creditModelsView(telegramId) {
  const [catalog, overview, disabled, access] = await Promise.all([
    getCreditCatalog(),
    getCreditOverview(telegramId).catch(() => null),
    getDisabledModels(),
    getModelAccess(telegramId).catch(() => null),
  ]);
  const unlocked = new Set(access?.granted ? access.models : []);
  const covered = new Set((overview?.passes?.active || []).flatMap((pass) => pass.models));
  const available = overview?.account.available || 0;
  const basis = available > 0 ? available : 10_000_000;
  const visible = catalog.models.filter((entry) => entry.listed && (!isDisabledIn(disabled, entry.model) || unlocked.has(entry.model)));
  const sections = MODEL_FAMILIES.map((family) => {
    const list = visible.filter((entry) => entry.family === family);
    if (!list.length) return '';
    const lines = list.map((entry) => {
      const name = `<code>${escapeHtml(entry.model)}</code>${covered.has(entry.model) ? ' \u{267E}\u{FE0F}' : ''}`;
      if (entry.status === 'active') {
        const via = entry.routedTo ? ` <i>(\u{2192} ${escapeHtml(entry.routedTo)})</i>` : (entry.alias && entry.rateModel !== entry.model ? ` <i>(alias \u{2192} ${escapeHtml(entry.rateModel)})</i>` : '');
        const tool = entry.toolCallCredits ? ` + ${formatTokens(entry.toolCallCredits)} kredit/tool` : '';
        return `\u{2022} ${name} ${multiplierText(entry.multiplier)}${via}${tool} \u{2014} \u{00B1}${shortNumber(tokensAt(basis, entry.multiplier))}`;
      }
      return `\u{2022} ${name} \u{23F3} <i>${entry.status === 'alias' ? 'alias, menunggu mapping admin' : 'menunggu konfigurasi'}</i>`;
    });
    return `<b>${family}</b>\n${lines.join('\n')}`;
  }).filter(Boolean);
  const header = [
    '\u{1F4CB} <b>MODEL &amp; MULTIPLIER</b>',
    DIVIDER,
    'Kredit terpakai = (token input + token output) \u{00D7} multiplier. Angka ini tarif jual toko ini, bukan harga resmi provider.',
    `Angka setelah \u{2014} = perkiraan token dari ${available > 0 ? `saldo kamu (${shortNumber(available)} kredit)` : '10 jt kredit'}.`,
    covered.size > 0 && '\u{267E}\u{FE0F} = termasuk paket unlimited kamu (tidak memotong kredit).',
    '\u{23F3} = belum bisa dipakai dengan kredit sampai admin mengatur tarifnya.',
  ].filter(Boolean).join('\n');
  let text = `${header}\n\n${sections.join('\n\n')}`;
  if (text.length > 4000) text = `${text.slice(0, 3980)}\n\u{2026}`;
  const rows = [[{ text: BUY_CREDITS_BUTTON, callback_data: 'top_up' }]];
  // The old per-1M Rupiah price list only matters to users who still hold a Rupiah balance.
  if (overview?.legacy?.balance > 0) rows.push([{ text: '\u{1F4B5} Harga saldo Rupiah lama', callback_data: 'model_price' }]);
  rows.push(creditBackRow());
  return { text, reply_markup: { inline_keyboard: rows } };
}

function ledgerLine(entry) {
  const when = escapeHtml(shortTime(entry.at));
  const signed = (value) => `${value > 0 ? '+' : ''}${formatTokens(value)}`;
  if (entry.type === 'purchase') {
    return `\u{2795} ${when} \u{2022} Beli paket ${escapeHtml(entry.packageId || '')} (${rupiah(entry.priceIdr)})\n   <b>${signed(entry.credits)}</b> kredit \u{2192} saldo ${formatTokens(entry.balanceAfter)}`;
  }
  if (entry.type === 'usage') {
    const flags = [entry.estimated && 'estimasi', entry.partial && 'terputus', entry.shortfall && `kurang ${formatTokens(entry.shortfall)}`].filter(Boolean).join(', ');
    const rate = entry.rateModel && entry.rateModel !== entry.model ? ` tarif ${escapeHtml(entry.rateModel)}` : '';
    return `\u{2796} ${when} \u{2022} <code>${escapeHtml(entry.model || '?')}</code> ${multiplierText(entry.multiplier)}${rate}\n   in ${formatTokens(entry.inputTokens)}${entry.cachedInputTokens ? ` (cache ${formatTokens(entry.cachedInputTokens)})` : ''} \u{2022} out ${formatTokens(entry.outputTokens)} \u{2192} <b>${signed(entry.credits)}</b>${flags ? ` <i>(${flags})</i>` : ''}`;
  }
  if (entry.type === 'refund') return `\u{21A9}\u{FE0F} ${when} \u{2022} Refund <b>${signed(entry.credits)}</b>${entry.reason ? ` \u{2014} ${escapeHtml(entry.reason)}` : ''}`;
  if (entry.type === 'adjustment') return `\u{1F6E0}\u{FE0F} ${when} \u{2022} Penyesuaian admin <b>${signed(entry.credits)}</b>${entry.reason ? ` \u{2014} ${escapeHtml(entry.reason)}` : ''}`;
  if (entry.type === 'unlimited_purchase') return `\u{267E}\u{FE0F} ${when} \u{2022} Paket unlimited ${unlimitedDurationLabel(entry.hours)} (${rupiah(entry.priceIdr)})\n   ${escapeHtml(shortTime(entry.startsAt))} \u{2192} ${escapeHtml(shortTime(entry.endsAt))}`;
  return `${when} \u{2022} ${escapeHtml(entry.type)}`;
}

async function creditHistoryView(telegramId) {
  const overview = await getCreditOverview(telegramId);
  const recent = overview.recent.slice(0, CREDIT_HISTORY_SHOWN);
  const pending = overview.orders.filter((order) => order.status === 'PENDING').slice(0, 3);
  const lines = [
    '\u{1F9FE} <b>RIWAYAT KREDIT</b>',
    DIVIDER,
    ...(recent.length ? recent.map(ledgerLine) : ['Belum ada transaksi kredit. \u{1F4ED}']),
  ];
  if (pending.length) {
    lines.push('', '\u{23F3} <b>Menunggu pembayaran</b>', ...pending.map((order) => `\u{2022} <code>${escapeHtml(order.orderId)}</code> ${rupiah(order.priceIdr)}`));
  }
  lines.push('', '<i>Detail per request (token, multiplier, kredit) juga ada di menu Logs.</i>');
  const rows = pending.map((order) => [{ text: `\u{1F504} Cek ${order.orderId.slice(-6)}`, callback_data: `status_${order.orderId}` }]);
  rows.push([{ text: '\u{1F9FE} Logs', callback_data: 'logs' }], creditBackRow());
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function creditUnlimitedView(telegramId) {
  const [catalog, overview] = await Promise.all([getCreditCatalog(), getCreditOverview(telegramId).catch(() => null)]);
  const unlimited = catalog.unlimited;
  const mine = [...(overview?.passes?.active || []), ...(overview?.passes?.scheduled || [])];
  const lines = [`\u{267E}\u{FE0F} <b>${escapeHtml(unlimited.name.toUpperCase())}</b>`, DIVIDER];
  for (const pass of mine.slice(0, 3)) {
    lines.push(card(`<b>Paket kamu</b> ${pass.status === 'active' ? '(aktif)' : '(menunggu mulai)'}`, [
      `${escapeHtml(wibTime(pass.startsAt))} \u{2192} <b>${escapeHtml(wibTime(pass.endsAt))}</b>`,
      ...unlimitedTerms(pass),
    ]));
  }
  const forSale = unlimited.durations.filter((item) => item.active && item.priceIdr !== null);
  if (!unlimited.saleEnabled || !forSale.length) {
    lines.push('Penjualan paket unlimited <b>belum dibuka</b>: harga belum ditetapkan admin.');
  } else {
    lines.push('<b>Pilih durasi</b>', ...forSale.map((item) => `\u{2022} ${unlimitedDurationLabel(item.hours)}: <b>${rupiah(item.priceIdr)}</b>`));
  }
  lines.push('', card('<b>Ketentuan</b>', [
    ...unlimitedTerms(unlimited),
    'Waktu dihitung sejak pembayaran terverifikasi; beli lagi saat aktif = mulai setelah paket sekarang berakhir',
  ]));
  const rows = unlimited.saleEnabled ? forSale.map((item) => [{ text: `\u{267E}\u{FE0F} ${unlimitedDurationLabel(item.hours)} \u{2022} ${rupiah(item.priceIdr)}`, callback_data: `ulbuy_${item.hours}` }]) : [];
  rows.push(creditBackRow());
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// ----- Admin -----

function adminCreditKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{2716}\u{FE0F} Multiplier', callback_data: 'admin_cr_rates' }, { text: '\u{1F500} Routing & alias', callback_data: 'admin_cr_routing' }],
    [{ text: '\u{1F4E6} Paket, batas & billing', callback_data: 'admin_cr_limits' }, { text: '\u{267E}\u{FE0F} Unlimited', callback_data: 'admin_cr_ul' }],
    [{ text: '\u{1F9FE} Order', callback_data: 'admin_cr_orders' }, { text: '\u{1F4DC} Audit', callback_data: 'admin_cr_audit' }],
    [{ text: '\u{2328}\u{FE0F} Ketik perintah', callback_data: 'admin_cr_cmd' }],
    [{ text: '\u{1F504} Refresh', callback_data: 'admin_cr' }, { text: '\u{1F519} Admin panel', callback_data: 'admin_panel' }],
  ] };
}

function adminCreditSubKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{2328}\u{FE0F} Ketik perintah', callback_data: 'admin_cr_cmd' }],
    [{ text: '\u{1F519} Kredit & Paket', callback_data: 'admin_cr' }],
  ] };
}

async function adminCreditView(notice = '') {
  const [admin, stats, catalog] = await Promise.all([getCreditAdmin(), getCreditStats(), getCreditCatalog()]);
  const { config } = admin;
  const listed = catalog.models.filter((entry) => entry.listed);
  const pendingModels = listed.filter((entry) => entry.status !== 'active');
  const routingRules = Object.values(config.routing).reduce((sum, rules) => sum + Object.keys(rules).length, 0);
  const onOff = (on) => (on ? '\u{1F7E2} ON' : '\u{1F534} OFF');
  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F48E} <b>KREDIT &amp; PAKET</b> <i>(config v${config.version})</i>`,
    DIVIDER,
    card('\u{1F4CA} <b>Statistik</b>', [
      `Akun: <b>${formatTokens(stats.accounts)}</b> \u{2022} kredit beredar: <b>${bigNumber(stats.totalBalance)}</b>`,
      `Direservasi: <b>${bigNumber(stats.totalReserved)}</b> (${formatTokens(stats.openReservations)} request)`,
      `Terjual: <b>${bigNumber(stats.purchased)}</b> \u{2022} terpakai: <b>${bigNumber(stats.used)}</b>`,
      `Pendapatan: <b>${rupiah(stats.revenueIdr)}</b> (kredit ${rupiah(stats.creditRevenueIdr)} \u{2022} unlimited ${rupiah(stats.unlimitedRevenueIdr)})`,
      `Order: ${formatTokens(stats.settledOrders)} lunas \u{2022} ${formatTokens(stats.pendingOrders)} pending \u{2022} unlimited aktif: ${formatTokens(stats.activePasses)}`,
      stats.shortfall > 0 && `\u{26A0}\u{FE0F} Tidak tertagih (saldo habis): ${bigNumber(stats.shortfall)}`,
    ]),
    card('\u{1F4E6} <b>Paket kredit</b>', config.packages.length
      ? config.packages.map((item) => `${item.active ? '\u{1F7E2}' : '\u{1F534}'} <code>${escapeHtml(item.id)}</code> ${bigNumber(item.credits)} kredit \u{2022} ${rupiah(item.priceIdr)}`)
      : ['Belum ada paket']),
    card('\u{2699}\u{FE0F} <b>Billing</b>', [
      `Jual kredit: <b>${onOff(config.billing.creditSalesEnabled)}</b> \u{2022} saldo Rupiah lama dipakai: <b>${onOff(config.billing.legacyRupiahEnabled)}</b>`,
      `Top up Rupiah lama: <b>${onOff(config.billing.legacyTopupEnabled)}</b>`,
      `Unlimited dijual: <b>${onOff(config.unlimited.saleEnabled)}</b> \u{2022} routing: <b>${formatTokens(routingRules)}</b> aturan`,
    ]),
    card('\u{1F916} <b>Model</b>', [
      `Aktif: <b>${formatTokens(listed.length - pendingModels.length)}</b> \u{2022} menunggu konfigurasi: <b>${formatTokens(pendingModels.length)}</b>`,
      pendingModels.length && pendingModels.slice(0, 12).map((entry) => `<code>${escapeHtml(entry.model)}</code>`).join(', '),
    ]),
    '<i>Ubah multiplier langsung lewat tombol Multiplier. Pengaturan lainnya lewat Ketik perintah. Semua perubahan dicatat di Audit.</i>',
  ];
  return { text: lines.join('\n'), reply_markup: adminCreditKeyboard() };
}

const MULTIPLIER_PAGE_SIZE = 10;
const MULTIPLIER_PRESETS = ['0.5', '1', '1.25', '1.5', '1.75', '2', '2.5', '3'];

// Stable short IDs fit Telegram's 64-byte callback limit, even for long names.
function multiplierModelId(model) {
  return crypto.createHash('sha256').update(model).digest('hex').slice(0, 12);
}

async function adminCreditRatesView(adminId, page = 0, search) {
  const catalog = await getCreditCatalog();
  const query = search === undefined ? (adminMultiplierLists.get(adminId)?.search || '') : String(search).trim().slice(0, 80);
  const models = catalog.models.filter((entry) => entry.model.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.listed) - Number(a.listed) || a.model.localeCompare(b.model));
  const pages = Math.max(1, Math.ceil(models.length / MULTIPLIER_PAGE_SIZE));
  const currentPage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  adminMultiplierLists.set(adminId, { search: query, page: currentPage });
  const visible = models.slice(currentPage * MULTIPLIER_PAGE_SIZE, (currentPage + 1) * MULTIPLIER_PAGE_SIZE);
  const rows = visible.map((entry) => [{
    text: `${entry.status === 'active' ? multiplierText(entry.multiplier) : '\u{23F3}'} ${entry.model}${entry.listed ? '' : ' (tersimpan)'}`,
    callback_data: `admin_cr_rate_${multiplierModelId(entry.model)}`,
  }]);
  const navigation = [];
  if (currentPage > 0) navigation.push({ text: '\u{2B05}\u{FE0F} Sebelumnya', callback_data: `admin_cr_rates_page_${currentPage - 1}` });
  if (currentPage + 1 < pages) navigation.push({ text: 'Berikutnya \u{27A1}\u{FE0F}', callback_data: `admin_cr_rates_page_${currentPage + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: '\u{1F50E} Cari model', callback_data: 'admin_cr_rates_search' }, { text: '\u{1F4CB} Semua model', callback_data: 'admin_cr_rates' }]);
  rows.push([{ text: '\u{1F519} Admin panel', callback_data: 'admin_panel' }, { text: '\u{1F48E} Kredit & Paket', callback_data: 'admin_cr' }]);
  return {
    text: [
      '\u{2716}\u{FE0F} <b>MULTIPLIER MODEL</b>',
      'Pilih model, lalu tekan nilai multiplier atau masukkan angka sendiri. Perubahan langsung berlaku untuk request baru.',
      query ? `Pencarian: <b>${escapeHtml(query)}</b>` : '',
      `${models.length} model \u{2022} halaman ${currentPage + 1}/${pages}`,
      models.length ? '\u{23F3} = belum siap digunakan. Model tersimpan tetap bisa diatur meskipun tidak ada di daftar upstream.' : 'Tidak ada model yang cocok. Coba kata pencarian lain.',
    ].filter(Boolean).join('\n\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

async function loadMultiplierModel(key) {
  const [admin, catalog] = await Promise.all([getCreditAdmin(), getCreditCatalog()]);
  if (admin.config.version !== catalog.version) throw new Error('Konfigurasi sedang berubah. Buka model ini lagi.');
  const matches = catalog.models.filter((entry) => multiplierModelId(entry.model) === key);
  if (matches.length !== 1) throw new Error('Model tidak ditemukan. Buka daftar model lagi.');
  const entry = matches[0];
  const config = admin.config;
  let target = config.routing?.[entry.provider]?.[entry.model] || entry.model;
  const visited = new Set();
  // Follow the default alias target without replacing its mapping or tool price.
  while (config.rates[target]?.status === 'alias') {
    if (visited.has(target) || visited.size >= 6 || !config.rates[target].target) {
      target = null;
      break;
    }
    visited.add(target);
    target = config.rates[target].target;
  }
  return { key, entry, config, target, rate: target ? config.rates[target] : null };
}

async function adminMultiplierModelView(key, notice = '', loaded) {
  const { entry, config, target, rate } = loaded || await loadMultiplierModel(key);
  const rows = [];
  if (target) {
    for (let index = 0; index < MULTIPLIER_PRESETS.length; index += 4) {
      rows.push(MULTIPLIER_PRESETS.slice(index, index + 4).map((value) => ({
        text: multiplierText(value), callback_data: `admin_cr_rate_set_${key}_${config.version}_${value}`,
      })));
    }
    rows.push([{ text: '\u{2328}\u{FE0F} Masukkan nilai sendiri', callback_data: `admin_cr_rate_custom_${key}_${config.version}` }]);
  } else {
    rows.push([{ text: '\u{1F500} Atur routing & alias', callback_data: 'admin_cr_routing' }]);
  }
  rows.push([{ text: '\u{1F519} Daftar model', callback_data: 'admin_cr_rates_back' }, { text: '\u{1F504} Refresh', callback_data: `admin_cr_rate_${key}` }]);
  const split = rate?.status === 'active' && (rate.input || rate.cachedInput || rate.output);
  return {
    text: [
      notice,
      '\u{2716}\u{FE0F} <b>ATUR MULTIPLIER</b>',
      `Model: <code>${escapeHtml(entry.model)}</code>`,
      target && target !== entry.model ? `Tarif mengikuti: <code>${escapeHtml(target)}</code>\nPerubahan juga berlaku untuk model lain yang memakai tarif tujuan ini.` : '',
      `Multiplier saat ini: <b>${rate?.status === 'active' ? multiplierText(rate.multiplier) : 'Belum diatur'}</b>`,
      split ? `Input ${multiplierText(rate.input || rate.multiplier)} \u{2022} cache ${multiplierText(rate.cachedInput || rate.input || rate.multiplier)} \u{2022} output ${multiplierText(rate.output || rate.multiplier)}` : '',
      entry.status !== 'active' ? `Status: ${escapeHtml(entry.reason || 'menunggu konfigurasi')}` : '',
      target
        ? 'Tekan angka untuk langsung menyimpan. Nilai berlaku untuk input, cache, dan output; pengaturan terpisah sebelumnya akan diganti.\nContoh: \u{00D7}1,5 = 1.000 token memakai 1.500 kredit.'
        : 'Alias ini belum memiliki tujuan yang valid. Atur mapping alias terlebih dahulu.',
      `<i>Konfigurasi v${config.version}. Setiap perubahan tercatat di Audit.</i>`,
    ].filter(Boolean).join('\n\n'),
    reply_markup: { inline_keyboard: rows },
  };
}

async function saveAdminMultiplier(adminId, key, version, value) {
  const loaded = await loadMultiplierModel(key);
  if (loaded.config.version !== Number(version)) throw new Error('Konfigurasi sudah berubah. Tekan Refresh dan pilih nilai lagi.');
  if (!loaded.target) throw new Error('Atur mapping alias terlebih dahulu.');
  const multiplier = creditRules.formatMultiplier(creditRules.parseMultiplier(value));
  const result = await updateCreditConfig({ op: 'setRate', model: loaded.target, multiplier }, adminId);
  return adminMultiplierModelView(key, `\u{2705} <b>Multiplier tersimpan: ${multiplierText(multiplier)}</b>\n<code>${escapeHtml(loaded.target)}</code> \u{2022} v${result.version}`);
}

async function adminCreditRoutingView() {
  const admin = await getCreditAdmin();
  const { config, providers } = admin;
  const rules = Object.entries(config.routing).flatMap(([provider, map]) => Object.entries(map).map(([model, target]) => `<code>${escapeHtml(provider)}</code>: ${escapeHtml(model)} \u{2192} <b>${escapeHtml(target)}</b>`));
  const deepseek = Object.entries(config.rates).filter(([model]) => model.startsWith('deepseek-'))
    .map(([model, rate]) => `<code>${escapeHtml(model)}</code> ${rate.status === 'active' ? multiplierText(rate.multiplier) : '\u{23F3}'} <i>${rate.type === 'checkpoint' ? 'checkpoint asli' : rate.type === 'alias' ? 'alias' : ''}</i>`);
  const aliases = Object.entries(config.rates).filter(([, rate]) => rate.status === 'alias')
    .map(([model, rate]) => `<code>${escapeHtml(model)}</code> \u{2192} ${rate.target ? `<b>${escapeHtml(rate.target)}</b>` : '<i>belum diatur</i>'}${rate.requiresToolPrice ? ` \u{2022} tool: ${rate.toolCallCredits === null ? '<i>belum diatur</i>' : formatTokens(rate.toolCallCredits)}` : ''}${Object.keys(rate.effortTargets || {}).length ? ` \u{2022} effort: ${escapeHtml(Object.entries(rate.effortTargets).map(([e, t]) => `${e}\u{2192}${t}`).join(', '))}` : ''}`);
  const lines = [
    '\u{1F500} <b>ROUTING &amp; ALIAS</b>',
    DIVIDER,
    'Routing per provider: catat bila provider mengarahkan suatu alias ke model lain. Tarif model tujuan yang dipakai, hanya untuk provider itu.',
    'Contoh: <code>route cbcn deepseek-v4-flash deepseek-v4.1-flash</code> (tarif \u{00D7}1,5).',
    '',
    card('<b>Aturan routing</b>', rules.length ? rules : ['Belum ada (semua provider memakai tarif model itu sendiri)']),
    card('<b>Provider di daftar model</b>', Object.entries(providers).map(([provider, models]) => `<code>${escapeHtml(provider)}</code>: ${formatTokens(models.length)} model`)),
    card('<b>DeepSeek</b>', deepseek),
    card('<b>Alias</b> (<code>alias</code>, <code>effort</code>, <code>tool</code>)', aliases.length ? aliases : ['-']),
  ];
  return { text: lines.join('\n'), reply_markup: adminCreditSubKeyboard() };
}

async function adminCreditLimitsView() {
  const { config } = await getCreditAdmin();
  const limits = config.limits;
  const lines = [
    '\u{1F4E6} <b>PAKET, BATAS &amp; BILLING</b>',
    DIVIDER,
    card('<b>Paket</b> (<code>paket &lt;id&gt; &lt;kredit&gt; &lt;harga&gt;</code>, <code>paket &lt;id&gt; on|off|hapus</code>)', config.packages.map((item) => `${item.active ? '\u{1F7E2}' : '\u{1F534}'} <code>${escapeHtml(item.id)}</code> ${bigNumber(item.credits)} kredit \u{2022} ${rupiah(item.priceIdr)}`)),
    card('<b>Batas reservasi</b> (<code>batas &lt;nama&gt; &lt;nilai&gt;</code>)', [
      `output_default: <b>${formatTokens(limits.defaultReserveOutputTokens)}</b> token (direservasi bila klien tidak memberi batas)`,
      `output_min: <b>${formatTokens(limits.minOutputTokens)}</b> token (di bawah ini request ditolak 402)`,
      `input_buffer: <b>${formatTokens(limits.inputSafetyPercent)}%</b> (cadangan estimasi input)`,
      `max_tokens_field: <b>${escapeHtml(limits.chatMaxTokensField)}</b> (chat/completions)`,
      `ttl: <b>${formatTokens(limits.reservationTtlMinutes)}</b> menit \u{2022} orphan: <b>${escapeHtml(limits.orphanPolicy)}</b>`,
      `tool_reserve: <b>${formatTokens(limits.toolCallReserve)}</b> tool call`,
    ]),
    card('<b>Billing</b> (<code>billing &lt;nama&gt; on|off</code>)', [
      `jual_kredit: <b>${config.billing.creditSalesEnabled ? 'on' : 'off'}</b>`,
      `legacy_rupiah: <b>${config.billing.legacyRupiahEnabled ? 'on' : 'off'}</b> (saldo Rupiah lama dipakai bila kredit habis)`,
      `legacy_topup: <b>${config.billing.legacyTopupEnabled ? 'on' : 'off'}</b> (tombol top up Rupiah lama)`,
    ]),
  ];
  return { text: lines.join('\n'), reply_markup: adminCreditSubKeyboard() };
}

async function adminCreditUnlimitedView() {
  const { config } = await getCreditAdmin();
  const unlimited = config.unlimited;
  const lines = [
    `\u{267E}\u{FE0F} <b>${escapeHtml(unlimited.name.toUpperCase())}</b> (admin)`,
    DIVIDER,
    `Dijual: <b>${unlimited.saleEnabled ? '\u{1F7E2} ON' : '\u{1F534} OFF'}</b> (<code>unlimited jual on|off</code>)`,
    card('<b>Durasi &amp; harga</b> (<code>unlimited harga &lt;jam&gt; &lt;harga&gt;</code>, <code>unlimited &lt;jam&gt; on|off</code>)', unlimited.durations.map((item) => `${item.active ? '\u{1F7E2}' : '\u{1F534}'} ${unlimitedDurationLabel(item.hours)}: ${item.priceIdr === null ? '<i>harga belum ditetapkan</i>' : rupiah(item.priceIdr)}`)),
    card('<b>Model</b> (<code>unlimited model tambah|hapus &lt;model&gt;</code>)', [unlimited.models.length ? unlimited.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(', ') : '<i>kosong: tidak ada model yang otomatis masuk</i>']),
    card('<b>Batas per user</b> (<code>unlimited batas concurrency|rpm|output &lt;nilai&gt;</code>)', [
      `Request bersamaan: <b>${formatTokens(unlimited.limits.maxConcurrent)}</b>`,
      `Request per menit: <b>${formatTokens(unlimited.limits.rpm)}</b>`,
      `Output maks per request: <b>${formatTokens(unlimited.limits.maxOutputTokens)}</b> token`,
    ]),
    '<i>Model, batas dan harga disalin ke paket saat dibeli; perubahan berlaku untuk pembelian berikutnya.</i>',
  ];
  return { text: lines.join('\n'), reply_markup: adminCreditSubKeyboard() };
}

async function adminCreditOrdersView() {
  const [pending, recent] = await Promise.all([listCreditOrders({ status: 'PENDING', limit: 10 }), listCreditOrders({ limit: 10 })]);
  const line = (order) => `${order.status === 'SETTLED' ? '\u{2705}' : order.status === 'FAILED' ? '\u{274C}' : '\u{23F3}'} <code>${escapeHtml(order.orderId)}</code>\n   ${order.kind === 'credits' ? `${bigNumber(order.credits)} kredit` : `unlimited ${unlimitedDurationLabel(order.hours)}`} \u{2022} ${rupiah(order.priceIdr)} \u{2022} user <code>${escapeHtml(order.userId)}</code>${order.lastRejectedAt ? ` \u{2022} \u{26A0}\u{FE0F} ditolak (dibayar ${order.lastRejectedAmount ?? '?'})` : ''}`;
  const lines = [
    '\u{1F9FE} <b>ORDER KREDIT</b>',
    DIVIDER,
    '<b>Pending</b>',
    ...(pending.length ? pending.map(line) : ['Tidak ada.']),
    '',
    '<b>Terbaru</b>',
    ...(recent.length ? recent.map(line) : ['Belum ada order.']),
    '',
    '<i>Konfirmasi manual (setelah kamu cek pembayarannya sendiri):</i> <code>order &lt;order id&gt; konfirmasi</code>',
  ];
  return { text: lines.join('\n').slice(0, 4000), reply_markup: adminCreditSubKeyboard() };
}

async function adminCreditAuditView() {
  const { audit } = await getCreditAdmin();
  const lines = [
    '\u{1F4DC} <b>AUDIT KONFIGURASI KREDIT</b>',
    DIVIDER,
    ...(audit.length ? audit.map((entry) => `v${entry.version} \u{2022} ${escapeHtml(shortTime(entry.at))} \u{2022} <code>${escapeHtml(entry.by)}</code>\n   ${escapeHtml(entry.change)}`) : ['Belum ada perubahan (semua nilai default).']),
    '',
    '<i>Penyesuaian kredit user dan refund tercatat di ledger kredit.</i>',
  ];
  return { text: lines.join('\n').slice(0, 4000), reply_markup: adminCreditSubKeyboard() };
}

function adminCreditHelpText() {
  return [
    '\u{2328}\u{FE0F} <b>Perintah kredit</b> \u{2014} kirim satu perintah per baris (boleh beberapa baris sekaligus).',
    '',
    `<code>${escapeHtml(creditRules.ADMIN_COMMAND_HELP.join('\n'))}</code>`,
    '',
    'Mode ini aktif sampai kamu menekan tombol lain.',
  ].join('\n');
}

async function notifyCreditUser(telegramId, text) {
  await telegram('sendMessage', { chat_id: telegramId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F48E} Kredit Token', callback_data: 'credits' }]] } }).catch(() => {});
}

// One admin command line -> result line (HTML).
async function runAdminCreditCommand(adminId, parsed, line) {
  if (parsed.error) return `\u{274C} <code>${escapeHtml(line.slice(0, 80))}</code>\n   ${escapeHtml(parsed.error)}`;
  try {
    if (parsed.kind === 'config') {
      const result = await updateCreditConfig(parsed.change, adminId);
      return `\u{2705} v${result.version}: <code>${escapeHtml(result.summary)}</code>`;
    }
    if (parsed.kind === 'adjust' || parsed.kind === 'refund') {
      const options = { actorId: adminId, reason: parsed.reason };
      const result = parsed.kind === 'adjust'
        ? await adjustCredits(parsed.userId, parsed.amount, options)
        : await refundCredits(parsed.userId, parsed.amount, options);
      const amount = `${parsed.amount > 0 ? '+' : ''}${formatTokens(parsed.amount)}`;
      await notifyCreditUser(parsed.userId, `\u{1F48E} <b>Kredit kamu ${parsed.kind === 'refund' ? 'di-refund' : 'disesuaikan admin'}: ${amount}</b>${parsed.reason ? `\nAlasan: ${escapeHtml(parsed.reason)}` : ''}\nSaldo kredit: <b>${bigNumber(result.available)}</b>`);
      return `\u{2705} ${parsed.kind === 'refund' ? 'Refund' : 'Kredit'} <code>${escapeHtml(parsed.userId)}</code> ${amount} \u{2192} saldo ${bigNumber(result.balance)}`;
    }
    if (parsed.kind === 'confirmOrder') {
      const result = await adminConfirmCreditOrder(parsed.orderId, adminId);
      if (result.alreadySettled) return `\u{2139}\u{FE0F} Order <code>${escapeHtml(parsed.orderId)}</code> sudah lunas sebelumnya.`;
      await notifyCreditUser(result.userId, result.kind === 'credits'
        ? `\u{2705} <b>Pembayaran dikonfirmasi admin.</b>\n+${bigNumber(result.credits)} kredit token. Saldo: <b>${bigNumber(result.balance)}</b>`
        : `\u{2705} <b>Pembayaran dikonfirmasi admin.</b>\nPaket unlimited aktif ${escapeHtml(wibTime(result.pass?.startsAt))} s/d ${escapeHtml(wibTime(result.pass?.endsAt))}.`);
      return `\u{2705} Order <code>${escapeHtml(parsed.orderId)}</code> dikonfirmasi (${result.kind === 'credits' ? `+${formatTokens(result.credits)} kredit` : 'unlimited'}).`;
    }
  } catch (error) {
    return `\u{274C} <code>${escapeHtml(line.slice(0, 80))}</code>\n   ${escapeHtml(error.message)}`;
  }
  return `\u{274C} <code>${escapeHtml(line.slice(0, 80))}</code>`;
}

async function handleAdminCreditInput(chatId, adminId, text) {
  const pending = pendingAdminCredit.get(adminId) || { mode: 'console' };
  if (pending.mode === 'rate_search') {
    pendingAdminCredit.delete(adminId);
    const view = await adminCreditRatesView(adminId, 0, text);
    return telegram('sendMessage', { chat_id: chatId, ...view, parse_mode: 'HTML' });
  }
  if (pending.mode === 'rate') {
    let view;
    try {
      view = await saveAdminMultiplier(adminId, pending.key, pending.version, text);
      pendingAdminCredit.delete(adminId);
    } catch (error) {
      view = { text: `\u{274C} ${escapeHtml(error.message)}\n\nKirim angka positif, misalnya <code>1,75</code> (maksimal 1000 dan 4 desimal).`, reply_markup: { inline_keyboard: [[{ text: '\u{1F504} Refresh / Batal', callback_data: `admin_cr_rate_${pending.key}` }]] } };
    }
    return telegram('sendMessage', { chat_id: chatId, ...view, parse_mode: 'HTML' });
  }
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 20);
  const results = [];
  for (const line of lines) {
    let parsed;
    if (pending.mode === 'user') {
      const refund = line.match(/^refund\s+(\S+)(?:\s+(.*))?$/i);
      parsed = creditRules.parseAdminCommand(refund ? `refund ${pending.targetId} ${refund[1]} ${refund[2] || ''}` : `kredit ${pending.targetId} ${line}`);
    } else {
      parsed = creditRules.parseAdminCommand(line);
    }
    results.push(await runAdminCreditCommand(adminId, parsed, line));
  }
  if (pending.mode === 'user') {
    pendingAdminCredit.delete(adminId);
    return sendAdminUserDetail(chatId, adminId, pending.targetId, results.join('\n'));
  }
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `${results.join('\n') || 'Tidak ada perintah.'}\n\n<i>Kirim perintah lagi, atau tekan tombol untuk selesai.</i>`.slice(0, 4000),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '\u{2753} Bantuan perintah', callback_data: 'admin_cr_cmd' }], [{ text: '\u{1F519} Kredit & Paket', callback_data: 'admin_cr' }]] },
  });
}

const ADMIN_CREDIT_VIEWS = {
  admin_cr: adminCreditView,
  admin_cr_routing: adminCreditRoutingView,
  admin_cr_limits: adminCreditLimitsView,
  admin_cr_ul: adminCreditUnlimitedView,
  admin_cr_orders: adminCreditOrdersView,
  admin_cr_audit: adminCreditAuditView,
};

async function handleAdminCreditAction(query, action) {
  const chatId = query.message.chat.id;
  const adminId = String(query.from.id);
  if (action === 'admin_cr_rates') return showAdminView(query, await adminCreditRatesView(adminId, 0, ''));
  if (action === 'admin_cr_rates_back') return showAdminView(query, await adminCreditRatesView(adminId, adminMultiplierLists.get(adminId)?.page || 0));
  const page = action.match(/^admin_cr_rates_page_(\d+)$/);
  if (page) return showAdminView(query, await adminCreditRatesView(adminId, Number(page[1])));
  if (action === 'admin_cr_rates_search') {
    pendingAdminCredit.set(adminId, { mode: 'rate_search' });
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F50E} Kirim nama model atau sebagian namanya, misalnya <code>glm</code> atau <code>deepseek</code>.', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: 'admin_cr_rates_back' }]] } });
  }
  const model = action.match(/^admin_cr_rate_([a-f0-9]{12})$/);
  if (model) return showAdminView(query, await adminMultiplierModelView(model[1]));
  const custom = action.match(/^admin_cr_rate_custom_([a-f0-9]{12})_(\d+)$/);
  if (custom) {
    const loaded = await loadMultiplierModel(custom[1]);
    if (!loaded.target || loaded.config.version !== Number(custom[2])) return showAdminView(query, await adminMultiplierModelView(custom[1], 'Konfigurasi berubah. Pilih lagi dari nilai terbaru.', loaded));
    pendingAdminCredit.set(adminId, { mode: 'rate', key: custom[1], version: Number(custom[2]) });
    return telegram('sendMessage', { chat_id: chatId, text: `\u{2328}\u{FE0F} Kirim multiplier baru untuk <code>${escapeHtml(loaded.target)}</code>.\nContoh: <code>1,75</code> atau <code>2</code>.\nHarus lebih dari 0, maksimal 1000, hingga 4 desimal. Nilai berlaku untuk input, cache, dan output.`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: `admin_cr_rate_${custom[1]}` }]] } });
  }
  const preset = action.match(/^admin_cr_rate_set_([a-f0-9]{12})_(\d+)_(\d+(?:\.\d+)?)$/);
  if (preset) {
    try {
      if (!MULTIPLIER_PRESETS.includes(preset[3])) throw new Error('Pilihan multiplier tidak valid.');
      return showAdminView(query, await saveAdminMultiplier(adminId, preset[1], preset[2], preset[3]));
    } catch (error) {
      return showAdminView(query, await adminMultiplierModelView(preset[1], `\u{274C} ${escapeHtml(error.message)}`));
    }
  }
  if (action === 'admin_cr_cmd') {
    pendingAdminCredit.set(adminId, { mode: 'console' });
    return telegram('sendMessage', { chat_id: chatId, text: adminCreditHelpText(), parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Kredit & Paket', callback_data: 'admin_cr' }]] } });
  }
  if (action.startsWith('admin_cr_user_')) {
    const targetId = action.slice('admin_cr_user_'.length);
    if (!USER_ID_PATTERN.test(targetId)) return telegram('sendMessage', { chat_id: chatId, text: 'User tidak valid.', reply_markup: adminBackKeyboard() });
    pendingAdminCredit.set(adminId, { mode: 'user', targetId });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{1F48E} Kirim penyesuaian kredit untuk <code>${escapeHtml(targetId)}</code>:\n<code>+10000000 bonus event</code> tambah kredit\n<code>-500000 koreksi</code> kurangi kredit (maks kredit tersedia)\n<code>refund 25000 request gagal</code> refund\n\nTercatat di ledger dengan ID admin dan alasannya.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: `admin_topup_user_${targetId}` }]] },
    });
  }
  const view = ADMIN_CREDIT_VIEWS[action];
  if (!view) return telegram('sendMessage', { chat_id: chatId, text: 'Unknown action.', reply_markup: adminBackKeyboard() });
  const shown = await view();
  return action === 'admin_cr' && !query.message.text?.includes('KREDIT &')
    ? telegram('sendMessage', { chat_id: chatId, text: shown.text, parse_mode: 'HTML', reply_markup: shown.reply_markup })
    : showAdminView(query, shown);
}

async function sendDashboard(chatId, telegramId, notice = '') {
  let user = await getUser(telegramId);
  if (!user || !user.apiKeys.some((entry) => entry.active !== false)) {
    await createApiKey(telegramId);
  }
  const text = notice ? `${notice}\n\n${await statsMessage(telegramId)}` : await statsMessage(telegramId);
  await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
}

const REDEEM_FAILURES = {
  not_found: '\u{274C} Code not found. Check the code and try again.',
  disabled: '\u{1F6AB} This code has been disabled by the admin.',
  already_redeemed: '\u{26A0}\u{FE0F} You have already redeemed this code.',
  used_up: '\u{231B} This code has reached its usage limit.',
};

// Same normalization as usage-db.js normalizeRedeemCode.
function normalizeCodeInput(text) {
  return String(text || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function performUserRedeem(chatId, from, rawCode) {
  // One Redeem Code entry for both kinds: MDL-... codes unlock models, RDM-... codes add balance.
  if (ACCESS_CODE_PATTERN.test(normalizeCodeInput(rawCode))) return performAccessRedeem(chatId, from, rawCode);
  const result = await redeemCode(from.id, rawCode, { firstName: from.first_name, username: from.username });
  if (!result.ok) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: REDEEM_FAILURES[result.reason] || '\u{274C} Could not redeem this code.',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F501} Try another code', callback_data: 'redeem' }], [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }]] },
    });
  }
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `\u{1F389} <b>Code redeemed!</b>\n\nCode: <code>${escapeHtml(result.code)}</code>\nAdded: <b>${rupiah(result.amount)}</b>\nNew balance: <b>${rupiah(result.balance)}</b>`,
    parse_mode: 'HTML',
    reply_markup: menuKeyboard(from.id),
  });
  if (!isAdmin(from.id)) {
    const who = escapeHtml(from.first_name || from.username || from.id);
    await telegram('sendMessage', {
      chat_id: ADMIN_TELEGRAM_ID,
      text: `\u{1F39F}\u{FE0F} <b>${who}</b> (<code>${escapeHtml(from.id)}</code>) redeemed <code>${escapeHtml(result.code)}</code> for ${rupiah(result.amount)}. Uses left: ${result.usesLeft}.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  return null;
}

async function askRedeemUses(chatId, amount) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `\u{1F39F}\u{FE0F} <b>Create Redeem Code</b>\n\nNominal: <b>${rupiah(amount)}</b>\n\nHow many users can redeem this code? (each user can redeem it once)`,
    parse_mode: 'HTML',
    reply_markup: adminRedeemUsesKeyboard(amount),
  });
}

async function finishAdminRedeemCreate(chatId, adminId, amount, uses) {
  const entry = await createRedeemCode({ amount, maxUses: uses, createdBy: adminId });
  if (!entry) {
    return telegram('sendMessage', { chat_id: chatId, text: '\u{274C} Could not create the code: invalid nominal or quota.', reply_markup: adminRedeemKeyboard() });
  }
  return telegram('sendMessage', {
    chat_id: chatId,
    text: [
      '\u{2705} <b>Redeem code created!</b>',
      '',
      `Code: <code>${escapeHtml(entry.code)}</code>`,
      `Nominal: <b>${rupiah(entry.amount)}</b>`,
      `Quota: <b>${entry.maxUses} user(s)</b>`,
      '',
      'Tap the code to copy it. Users redeem it via <b>Redeem Code</b> in the menu, or by sending:',
      `<code>/redeem ${escapeHtml(entry.code)}</code>`,
    ].join('\n'),
    parse_mode: 'HTML',
    reply_markup: adminRedeemKeyboard(),
  });
}

// ---------- Support tickets ----------

const TICKET_MEDIA_TYPES = ['photo', 'document', 'video', 'voice', 'audio', 'sticker', 'animation', 'video_note'];

function ticketMediaType(message) {
  return TICKET_MEDIA_TYPES.find((type) => message[type]) || '';
}

// What gets saved in the database for one chat message. Attachments are kept
// as a pointer to the original Telegram message so the admin can open them later.
function ticketEntry(message) {
  if (message.text) return { text: message.text.trim() };
  const type = ticketMediaType(message) || 'message';
  return {
    text: message.caption ? message.caption.trim() : '',
    media: { type, chatId: message.chat.id, messageId: message.message_id },
  };
}

function ticketUserLabel(ticket) {
  const name = escapeHtml(ticket.firstName || 'User');
  const username = ticket.username ? ` (@${escapeHtml(ticket.username)})` : '';
  return `${name}${username} • <code>${escapeHtml(ticket.userId)}</code>`;
}

function ticketTime(iso) {
  return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' });
}

function ticketLine(entry, maxLength = 3000) {
  const who = entry.from === 'admin' ? '\u{1F6E0}\u{FE0F} Admin' : '\u{1F464} User';
  const attachment = entry.media ? `\u{1F4CE}[${escapeHtml(entry.media.type)}] ` : '';
  return `<b>${who}</b> <i>${escapeHtml(ticketTime(entry.at))}</i>\n${attachment}${escapeHtml(String(entry.text || '').slice(0, maxLength))}`;
}

// Short view for the user (last few messages).
function ticketTranscript(ticket, limit = 10) {
  const lines = ticket.messages.slice(-limit).map((entry) => ticketLine(entry, 400));
  const hidden = ticket.messages.length > limit ? `<i>(${ticket.messages.length - limit} older message(s) hidden)</i>\n\n` : '';
  return `${hidden}${lines.join('\n\n')}`;
}

// Full conversation for the admin, split to stay under Telegram's 4096-char limit.
function ticketTranscriptChunks(ticket, header) {
  const chunks = [];
  let current = header;
  for (const entry of ticket.messages) {
    const line = ticketLine(entry);
    if (current.length + line.length + 2 > 3800) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n\n' : ''}${line}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function userTicketKeyboard() {
  return { inline_keyboard: [
    [{ text: '\u{2705} Close ticket', callback_data: 'ticket_close' }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] };
}

function adminTicketKeyboard(ticketId) {
  return { inline_keyboard: [
    [{ text: '\u{1F4AC} Reply', callback_data: `admin_ticket_reply_${ticketId}` }, { text: '\u{2705} Close', callback_data: `admin_ticket_close_${ticketId}` }],
    [{ text: '\u{1F4C2} All tickets', callback_data: 'admin_tickets' }],
  ] };
}

const TICKET_LIST_LIMIT = 40;

function adminTicketListMessage(tickets) {
  if (!tickets.length) return '\u{1F3AB} <b>Tickets</b>\n\nNo tickets yet. \u{1F389}';
  const open = tickets.filter((t) => t.status === 'open').length;
  const lines = tickets.slice(0, TICKET_LIST_LIMIT).map((t) => {
    const icon = t.status === 'open' ? '\u{1F7E2}' : '\u{26AA}';
    const last = t.messages[t.messages.length - 1];
    const who = last?.from === 'admin' ? 'Admin' : 'User';
    const preview = last ? `${who}: ${last.media ? '\u{1F4CE} ' : ''}${String(last.text || '').slice(0, 50)}` : '';
    return `${icon} <b>#${t.id}</b> ${ticketUserLabel(t)}\n   <i>${escapeHtml(ticketTime(t.updatedAt))}</i> • ${t.messages.length} msg • ${escapeHtml(preview)}`;
  });
  const more = tickets.length > TICKET_LIST_LIMIT ? `\n\n<i>Showing the latest ${TICKET_LIST_LIMIT} of ${tickets.length} tickets.</i>` : '';
  return `\u{1F3AB} <b>All Tickets</b> — ${open} open, ${tickets.length - open} closed\n\n${lines.join('\n')}${more}\n\nTap a ticket to read the full chat and reply.`;
}

function adminTicketListKeyboard(tickets) {
  const buttons = tickets.slice(0, TICKET_LIST_LIMIT).map((ticket) => ({
    text: `${ticket.status === 'open' ? '\u{1F7E2}' : '\u{26AA}'} #${ticket.id} ${ticket.firstName || ticket.username || ticket.userId}`.slice(0, 40),
    callback_data: `admin_ticket_view_${ticket.id}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_tickets' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { inline_keyboard: rows };
}

// Send a text message to the admin and remember it, so replying to it
// in Telegram routes the answer to this ticket.
async function sendAdminTicketText(chatId, ticketId, text, replyMarkup) {
  const sent = await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
  await linkAdminMessage(ticketId, sent?.message_id);
  return sent;
}

// Admin opens a ticket: full saved conversation, then its attachments, then actions.
async function sendAdminTicketView(chatId, ticket) {
  const status = ticket.status === 'open' ? '\u{1F7E2} OPEN' : `\u{26AA} CLOSED by ${escapeHtml(ticket.closedBy || '-')}`;
  const header = `\u{1F3AB} <b>Ticket #${ticket.id}</b> • ${status}\nFrom: ${ticketUserLabel(ticket)}\nCreated: ${escapeHtml(ticketTime(ticket.createdAt))}\n\n`;
  for (const chunk of ticketTranscriptChunks(ticket, header)) {
    await sendAdminTicketText(chatId, ticket.id, chunk);
  }
  const attachments = ticket.messages.filter((entry) => entry.media).slice(-5);
  for (const entry of attachments) {
    try {
      const copied = await telegram('copyMessage', { chat_id: chatId, from_chat_id: entry.media.chatId, message_id: entry.media.messageId });
      await linkAdminMessage(ticket.id, copied?.message_id);
    } catch (error) {
      await telegram('sendMessage', { chat_id: chatId, text: `\u{1F4CE} An attachment from ${ticketTime(entry.at)} is no longer available (${error.message}).` }).catch(() => {});
    }
  }
  const actions = ticket.status === 'open'
    ? adminTicketKeyboard(ticket.id)
    : { inline_keyboard: [[{ text: '\u{1F4C2} All tickets', callback_data: 'admin_tickets' }]] };
  return sendAdminTicketText(chatId, ticket.id, ticket.status === 'open' ? 'Press Reply (or reply to any message above) to answer this user.' : 'This ticket is closed.', actions);
}

// Deliver one admin message (text or media) to the ticket's user.
async function forwardToUser(ticket, message) {
  const header = `\u{1F4AC} <b>Admin</b> • Ticket #${ticket.id}`;
  if (message.text) {
    return telegram('sendMessage', {
      chat_id: ticket.userId,
      text: `${header}\n\n${escapeHtml(message.text.slice(0, 3000))}\n\n<i>Balas langsung di chat ini untuk lanjut ngobrol dengan admin.</i>`,
      parse_mode: 'HTML',
      reply_markup: userTicketKeyboard(),
    });
  }
  await telegram('sendMessage', { chat_id: ticket.userId, text: `${header}\n\n\u{1F4CE} Admin mengirim lampiran:`, parse_mode: 'HTML' });
  return telegram('copyMessage', { chat_id: ticket.userId, from_chat_id: message.chat.id, message_id: message.message_id, reply_markup: userTicketKeyboard() });
}

async function startUserTicket(chatId, userId) {
  if (isAdmin(userId)) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '\u{1F3AB} You are the admin. All tickets are in the Admin Panel.',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F4C2} View tickets', callback_data: 'admin_tickets' }]] },
    });
  }
  const open = await getOpenTicketForUser(userId);
  if (open) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{1F3AB} <b>Ticket #${open.id}</b> masih terbuka.\n\n${ticketTranscript(open)}\n\n\u{270D}\u{FE0F} Kirim pesan di sini untuk lanjut chat dengan admin.`,
      parse_mode: 'HTML',
      reply_markup: userTicketKeyboard(),
    });
  }
  pendingUserTicket.add(String(userId));
  return telegram('sendMessage', {
    chat_id: chatId,
    text: '\u{1F3AB} <b>Create a Ticket</b>\n\nTulis pertanyaan atau kendala kamu sekarang (boleh kirim foto/screenshot juga). Pesan kamu akan disimpan dan admin akan membalas di chat ini. \u{1F4E8}',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '\u{274C} Cancel', callback_data: 'menu' }]] },
  });
}

// Routes a message into a ticket chat. Returns true when the message was handled.
async function routeTicketMessage(message, userId, user) {
  if (message.text && message.text.trim().startsWith('/')) return false;
  const chatId = message.chat.id;
  const entry = ticketEntry(message);

  if (isAdmin(userId)) {
    // A Telegram "reply" to a ticket message wins over the Reply-button chat mode.
    const replied = await findTicketByAdminMessage(message.reply_to_message?.message_id);
    const ticketId = replied ? replied.id : pendingAdminTicketReply.get(userId);
    if (!ticketId) return false;
    const ticket = await getTicket(ticketId);
    if (!ticket || ticket.status !== 'open') {
      pendingAdminTicketReply.delete(userId);
      await telegram('sendMessage', { chat_id: chatId, text: `\u{26A0}\u{FE0F} Ticket #${ticketId} is already closed. Message not sent.`, reply_markup: await adminKeyboard() });
      return true;
    }
    try {
      await forwardToUser(ticket, message);
    } catch (error) {
      await telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not deliver to the user: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminTicketKeyboard(ticket.id) });
      return true;
    }
    await addTicketMessage(ticket.id, 'admin', entry);
    pendingAdminTicketReply.set(userId, ticket.id);
    await sendAdminTicketText(chatId, ticket.id, `\u{2705} Sent to ${ticketUserLabel(ticket)} (Ticket #${ticket.id}).\nKeep typing to continue this chat.`, {
      inline_keyboard: [
        [{ text: '\u{2705} Close ticket', callback_data: `admin_ticket_close_${ticket.id}` }, { text: '\u{1F6AA} Exit chat', callback_data: 'admin_ticket_exit' }],
      ],
    });
    return true;
  }

  const open = await getOpenTicketForUser(userId);
  if (!open && !pendingUserTicket.has(userId)) return false;
  pendingUserTicket.delete(userId);
  // Saved to the database only; the admin reads it from Admin Panel -> Tickets.
  const ticket = open
    ? await addTicketMessage(open.id, 'user', entry)
    : await createTicket(userId, { firstName: user.first_name, username: user.username }, entry);
  const confirmation = open
    ? `\u{2705} Pesan tersimpan di Ticket #${ticket.id}.`
    : `\u{2705} <b>Ticket #${ticket.id} dibuat!</b>\n\nPesan kamu sudah tersimpan. Admin akan membalas di chat ini. Kamu bisa terus kirim pesan tambahan di sini.`;
  await telegram('sendMessage', { chat_id: chatId, text: confirmation, parse_mode: 'HTML', reply_markup: userTicketKeyboard() });
  return true;
}

// ---------- Admin: Disable Model ----------

async function ensureModelCache() {
  if (!supportedModelsCache.length) await syncSupportedModels();
  return supportedModelsCache;
}

function familyModels(familyIndex) {
  const family = MODEL_FAMILIES[familyIndex];
  return supportedModelsCache.filter((model) => getModelFamily(model) === family);
}

async function adminModelFamiliesView() {
  const models = await ensureModelCache();
  const disabled = await getDisabledModels();
  const lines = [];
  const rows = [];
  MODEL_FAMILIES.forEach((family, index) => {
    const list = models.filter((model) => getModelFamily(model) === family);
    const familyOff = disabled.families.includes(family);
    const offCount = familyOff ? list.length : list.filter((model) => disabled.models.includes(model.toLowerCase())).length;
    const icon = familyOff ? '\u{1F534}' : offCount ? '\u{1F7E1}' : '\u{1F7E2}';
    lines.push(`${icon} <b>${family}</b> — ${list.length - offCount}/${list.length} aktif${familyOff ? ' (family disabled)' : ''}`);
    rows.push([
      { text: `${icon} ${family} (${list.length})`, callback_data: `admin_mdl_fam_${index}` },
      { text: familyOff ? '\u{2705} Enable family' : '\u{1F6AB} Disable family', callback_data: `admin_mdl_ft_${index}` },
    ]);
  });
  rows.push([{ text: '\u{1F504} Resync models', callback_data: 'admin_models_sync' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  const text = [
    '\u{1F6AB} <b>Disable Model</b>',
    '',
    'Model yang di-disable tidak bisa dipakai lewat API dan disembunyikan dari daftar model user, kecuali oleh user yang punya <b>Kode Akses Model</b> aktif untuk model itu.',
    '\u{1F7E2} semua aktif • \u{1F7E1} sebagian disabled • \u{1F534} family disabled',
    '',
    ...lines,
    '',
    'Tap nama family untuk disable per model, atau pakai tombol Disable family.',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

async function adminFamilyModelsView(familyIndex) {
  await ensureModelCache();
  const family = MODEL_FAMILIES[familyIndex];
  const list = familyModels(familyIndex);
  const disabled = await getDisabledModels();
  const familyOff = disabled.families.includes(family);
  const buttons = list.map((model, modelIndex) => {
    const off = disabled.models.includes(model.toLowerCase());
    const icon = familyOff ? '\u{26D4}' : off ? '\u{1F534}' : '\u{1F7E2}';
    return { text: `${icon} ${model}`.slice(0, 60), callback_data: `admin_mdl_mt_${familyIndex}_${modelIndex}` };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: familyOff ? `\u{2705} Enable all ${family}` : `\u{1F6AB} Disable all ${family}`, callback_data: `admin_mdl_ft_${familyIndex}_in` }]);
  rows.push([{ text: '\u{1F519} Back to families', callback_data: 'admin_models' }]);
  const note = familyOff
    ? '\u{26D4} Family ini sedang <b>disabled</b>, jadi semua modelnya tidak bisa dipakai. Enable family dulu untuk mengatur per model.'
    : 'Tap model untuk disable/enable. \u{1F7E2} aktif • \u{1F534} disabled';
  const text = list.length
    ? `\u{1F6AB} <b>${family} Models</b> (${list.length})\n\n${note}`
    : `\u{1F6AB} <b>${family} Models</b>\n\nUpstream tidak mengembalikan model untuk family ini.`;
  return { text, reply_markup: { inline_keyboard: rows } };
}

// ---------- Admin: Rate Limit ----------

const RATE_LIMIT_MAX_RPM = 10_000;

function rpmLabel(rpm) {
  return rpm ? `${rpm} RPM` : 'no limit';
}

async function adminRateLimitFamiliesView() {
  const models = await ensureModelCache();
  const limits = await getRateLimits();
  const lines = [];
  const rows = [];
  MODEL_FAMILIES.forEach((family, index) => {
    const list = models.filter((model) => getModelFamily(model) === family);
    const familyRpm = limits.families[family] || 0;
    const overrides = list.filter((model) => limits.models[model.toLowerCase()]).length;
    const icon = familyRpm || overrides ? '\u{23F1}\u{FE0F}' : '\u{26AA}';
    lines.push(`${icon} <b>${family}</b> — family: ${rpmLabel(familyRpm)}${overrides ? ` • ${overrides} model limit` : ''}`);
    rows.push([
      { text: `${family} (${list.length})`, callback_data: `admin_rl_fam_${index}` },
      { text: familyRpm ? `\u{270F}\u{FE0F} Family ${familyRpm} RPM` : '\u{2795} Family limit', callback_data: `admin_rl_fs_${index}` },
    ]);
  });
  rows.push([{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  const text = [
    '\u{23F1}\u{FE0F} <b>Rate Limit</b>',
    '',
    'Batas request per menit (RPM) untuk <b>setiap user</b>. Limit model lebih prioritas daripada limit family.',
    'Family limit dihitung gabungan untuk semua model di family itu.',
    '',
    ...lines,
    '',
    'Tap nama family untuk atur limit per model.',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

async function adminRateLimitFamilyView(familyIndex) {
  await ensureModelCache();
  const family = MODEL_FAMILIES[familyIndex];
  const list = familyModels(familyIndex);
  const limits = await getRateLimits();
  const familyRpm = limits.families[family] || 0;
  const buttons = list.map((model, modelIndex) => {
    const own = limits.models[model.toLowerCase()];
    const label = own ? `${own} RPM` : familyRpm ? `family ${familyRpm}` : '\u{221E}';
    return { text: `${own ? '\u{23F1}\u{FE0F}' : '\u{26AA}'} ${model} · ${label}`.slice(0, 60), callback_data: `admin_rl_ms_${familyIndex}_${modelIndex}` };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: familyRpm ? `\u{270F}\u{FE0F} Family limit: ${familyRpm} RPM` : `\u{2795} Set ${family} family limit`, callback_data: `admin_rl_fs_${familyIndex}` }]);
  rows.push([{ text: '\u{1F519} Back to families', callback_data: 'admin_rl' }]);
  const text = list.length
    ? `\u{23F1}\u{FE0F} <b>${family} Rate Limit</b>\n\nFamily limit: <b>${rpmLabel(familyRpm)}</b>\n\nTap model untuk set limit khusus model itu.\n\u{23F1}\u{FE0F} limit model • \u{26AA} ikut family / tanpa limit`
    : `\u{23F1}\u{FE0F} <b>${family} Rate Limit</b>\n\nFamily limit: <b>${rpmLabel(familyRpm)}</b>\n\nUpstream tidak mengembalikan model untuk family ini.`;
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Asks the admin to type an RPM value for a family (modelIndex undefined) or one model.
async function promptRateLimit(chatId, userId, familyIndex, modelIndex) {
  const family = MODEL_FAMILIES[familyIndex];
  const limits = await getRateLimits();
  const model = modelIndex === undefined ? null : familyModels(familyIndex)[modelIndex];
  const current = model ? limits.models[model.toLowerCase()] : limits.families[family];
  const target = model ? `model <code>${escapeHtml(model)}</code>` : `family <b>${family}</b>`;
  pendingAdminRateLimit.set(String(userId), { familyIndex, modelIndex });
  const clearData = model ? `admin_rl_mc_${familyIndex}_${modelIndex}` : `admin_rl_fc_${familyIndex}`;
  const rows = [];
  if (current) rows.push([{ text: '\u{1F5D1}\u{FE0F} Remove limit', callback_data: clearData }]);
  rows.push([{ text: '\u{1F519} Cancel', callback_data: `admin_rl_fam_${familyIndex}` }]);
  return telegram('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `\u{23F1}\u{FE0F} Rate limit untuk ${target}\nSekarang: <b>${rpmLabel(current)}</b>\n\nKirim angka RPM per user (1–${formatTokens(RATE_LIMIT_MAX_RPM)}), atau <code>0</code> untuk hapus limit.`,
    reply_markup: { inline_keyboard: rows },
  });
}

async function applyRateLimit(familyIndex, modelIndex, rpm) {
  if (modelIndex === undefined) return setFamilyRateLimit(MODEL_FAMILIES[familyIndex], rpm);
  const model = familyModels(familyIndex)[modelIndex];
  if (!model) throw new Error('Model not found. Resync the model list and try again.');
  return setModelRateLimit(model, rpm);
}

// ---------- Admin: BANSOS (temporary free models) ----------
// The wizard keeps a draft per admin (bansosDrafts): 1) pick families/models,
// 2) set start and end, 3) confirm. The window itself lives in settings.json on the
// API server, which checks it on every request, so it ends by itself at endsAt.

// [button label, minutes]
const BANSOS_DURATIONS = [
  ['1 jam', 60], ['3 jam', 180], ['6 jam', 360],
  ['12 jam', 720], ['1 hari', 1440], ['3 hari', 4320],
  ['7 hari', 10080], ['14 hari', 20160], ['30 hari', 43200],
];
// Same limits as admin-settings.js (MAX_BANSOS_DURATION_MS / MAX_BANSOS_START_AHEAD_MS).
const BANSOS_MAX_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const BANSOS_MAX_START_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta has no daylight saving time

function toggleIn(list, value) {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

// The window in `windows` that covers `model` (same rule as the API server), or null.
function bansosWindowFor(windows, model) {
  const key = String(model || '').toLowerCase();
  const family = getModelFamily(model);
  return windows.find((entry) => (entry.models || []).includes(key) || Boolean(family && (entry.families || []).includes(family))) || null;
}

// 90_060_000 -> "1 hari 1 jam", 3_720_000 -> "1 jam 2 menit".
function durationText(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} hari`);
  if (hours) parts.push(`${hours} jam`);
  if (rest && !days) parts.push(`${rest} menit`);
  return parts.join(' ') || '< 1 menit';
}

// "2026-10-05 08:00" or "05/10/2026 08.00", read as WIB. Null when it is not a real date.
function parseWibDateTime(text) {
  const value = String(text || '').trim();
  let year; let month; let day; let hour; let minute;
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2})[:.](\d{2})$/);
  if (match) {
    [, year, month, day, hour, minute] = match.map(Number);
  } else {
    match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2})[:.](\d{2})$/);
    if (!match) return null;
    [, day, month, year, hour, minute] = match.map(Number);
  }
  const time = Date.UTC(year, month - 1, day, hour, minute) - WIB_OFFSET_MS;
  const check = new Date(time + WIB_OFFSET_MS);
  const exact = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    && check.getUTCHours() === hour && check.getUTCMinutes() === minute;
  return exact ? time : null;
}

// Typing format for parseWibDateTime, e.g. "2026-10-05 08:00".
function wibInputFormat(time) {
  const date = new Date(time + WIB_OFFSET_MS);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

// Request-log timestamp in WIB (GMT+7), e.g. "2026-10-02 19:06:09". Unparseable values pass through unchanged.
function wibLogTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return String(iso || '-');
  const seconds = String(new Date(time + WIB_OFFSET_MS).getUTCSeconds()).padStart(2, '0');
  return `${wibInputFormat(time)}:${seconds}`;
}

// "90m", "90 menit", "6j", "6 jam", "2d", "2 hari" -> milliseconds. Null otherwise.
function parseDurationText(text) {
  const match = String(text || '').trim().toLowerCase().match(/^(\d+)\s*(m|mnt|menit|j|jam|d|hari)$/);
  if (!match) return null;
  const minutes = { m: 1, mnt: 1, menit: 1, j: 60, jam: 60, d: 1440, hari: 1440 }[match[2]];
  const ms = Number(match[1]) * minutes * 60_000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

// "Qwen (family) • glm-5.3", limited to `limit` items so long lists fit in a message.
function bansosTargetsText(entry, limit = 4) {
  const items = [
    ...(entry.families || []).map((family) => `<b>${escapeHtml(family)}</b> (family)`),
    ...(entry.models || []).map((model) => `<code>${escapeHtml(model)}</code>`),
  ];
  if (!items.length) return '<i>belum ada</i>';
  const shown = items.slice(0, limit).join(' \u{2022} ');
  return items.length > limit ? `${shown} \u{2022} +${items.length - limit} lainnya` : shown;
}

function bansosDraft(userId) {
  return bansosDrafts.get(String(userId)) || null;
}

function bansosStartText(draft) {
  return draft.startsAt ? escapeHtml(wibTime(draft.startsAt)) : 'Sekarang (saat dikonfirmasi)';
}

function bansosEndText(draft) {
  if (draft.endsAt) {
    const length = draft.startsAt ? ` (${durationText(Date.parse(draft.endsAt) - Date.parse(draft.startsAt))})` : '';
    return `${escapeHtml(wibTime(draft.endsAt))}${length}`;
  }
  if (draft.durationMs) return `${durationText(draft.durationMs)} setelah mulai`;
  return '<i>belum diatur</i>';
}

async function adminBansosView(notice = '') {
  const entries = await listBansos();
  const now = Date.now();
  const active = entries.filter((entry) => entry.status === 'active');
  const scheduled = entries.filter((entry) => entry.status === 'scheduled');
  const finished = entries.filter((entry) => entry.status === 'ended' || entry.status === 'stopped').slice(0, 3);
  const lines = [
    ...(notice ? [notice, ''] : []),
    '\u{1F381} <b>BANSOS — Model Gratis</b>',
    '',
    'Gratiskan model atau seluruh family untuk sementara. Selama aktif: tarif <b>Rp0</b>, saldo & bonus token tidak terpotong, dan user bersaldo Rp0 tetap bisa memakai model itu. Setelah waktunya habis, harga & akses kembali normal otomatis.',
    '',
    `\u{1F7E2} <b>Aktif (${active.length})</b>`,
    ...(active.length
      ? active.map((entry) => `<code>#${escapeHtml(entry.id)}</code> ${bansosTargetsText(entry)}\n   s/d ${escapeHtml(wibTime(entry.endsAt))} (sisa ${durationText(Date.parse(entry.endsAt) - now)})`)
      : ['Tidak ada.']),
    '',
    `\u{23F3} <b>Terjadwal (${scheduled.length})</b>`,
    ...(scheduled.length
      ? scheduled.map((entry) => `<code>#${escapeHtml(entry.id)}</code> ${bansosTargetsText(entry)}\n   ${escapeHtml(wibTime(entry.startsAt))} \u{2192} ${escapeHtml(wibTime(entry.endsAt))}`)
      : ['Tidak ada.']),
  ];
  if (finished.length) {
    lines.push('', '\u{1F558} <b>Riwayat terakhir</b>', ...finished.map((entry) => {
      const end = entry.status === 'stopped' ? `dihentikan ${wibTime(entry.stoppedAt)}` : `berakhir ${wibTime(entry.endsAt)}`;
      return `<code>#${escapeHtml(entry.id)}</code> ${bansosTargetsText(entry, 3)}\n   ${escapeHtml(end)}`;
    }));
  }
  lines.push('', '<i>Model yang di-disable tetap tidak bisa dipakai, dan rate limit tetap berlaku.</i>');
  const rows = [[{ text: '\u{2795} Buat BANSOS', callback_data: 'admin_bsn_new' }]];
  const stopButtons = [...active, ...scheduled].map((entry) => ({
    text: `${entry.status === 'active' ? '\u{1F6D1} Stop' : '\u{1F5D1}\u{FE0F} Batalkan'} #${entry.id}`,
    callback_data: `admin_bsn_stop_${entry.id}`,
  }));
  for (let i = 0; i < stopButtons.length; i += 2) rows.push(stopButtons.slice(i, i + 2));
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_bsn_list' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// Step 1: whole families and/or single models.
async function adminBansosTargetsView(userId, notice = '') {
  const models = await ensureModelCache();
  const draft = bansosDraft(userId);
  const rows = MODEL_FAMILIES.map((family, index) => {
    const list = models.filter((model) => getModelFamily(model) === family);
    const whole = draft.families.includes(family);
    const picked = list.filter((model) => draft.models.includes(model.toLowerCase())).length;
    const icon = whole ? '\u{2705}' : picked ? '\u{2611}\u{FE0F}' : '\u{26AA}';
    return [
      { text: `${icon} ${family} (${whole ? list.length : picked}/${list.length})`, callback_data: `admin_bsn_fam_${index}` },
      { text: whole ? '\u{2716}\u{FE0F} Batal family' : '\u{2795} Seluruh family', callback_data: `admin_bsn_ft_${index}` },
    ];
  });
  rows.push([{ text: '\u{27A1}\u{FE0F} Lanjut: atur durasi', callback_data: 'admin_bsn_next' }]);
  rows.push([{ text: '\u{274C} Batal', callback_data: 'admin_bsn_cancel' }]);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F381} <b>Buat BANSOS</b> — 1/3 Pilih model',
    '',
    'Tap <b>\u{2795} Seluruh family</b> untuk menggratiskan semua model di family itu (termasuk model yang baru muncul nanti), atau tap nama family untuk memilih model satuan.',
    '\u{2705} seluruh family \u{2022} \u{2611}\u{FE0F} sebagian model \u{2022} \u{26AA} belum dipilih',
    '',
    `Dipilih: ${bansosTargetsText(draft, 12)}`,
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

async function adminBansosFamilyView(userId, familyIndex) {
  await ensureModelCache();
  const family = MODEL_FAMILIES[familyIndex];
  const list = familyModels(familyIndex);
  const draft = bansosDraft(userId);
  const whole = draft.families.includes(family);
  const buttons = list.map((model, modelIndex) => {
    const picked = whole || draft.models.includes(model.toLowerCase());
    return { text: `${picked ? '\u{2705}' : '\u{26AA}'} ${model}`.slice(0, 60), callback_data: `admin_bsn_mt_${familyIndex}_${modelIndex}` };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: whole ? `\u{2716}\u{FE0F} Batal pilih seluruh ${family}` : `\u{2795} Pilih seluruh ${family}`, callback_data: `admin_bsn_ft_${familyIndex}_in` }]);
  rows.push([{ text: '\u{1F519} Kembali ke family', callback_data: 'admin_bsn_targets' }]);
  const note = whole
    ? `\u{2705} Seluruh family <b>${family}</b> sudah dipilih, jadi semua modelnya ikut gratis. Batalkan pilihan family dulu untuk memilih per model.`
    : 'Tap model untuk pilih/batal. \u{2705} dipilih \u{2022} \u{26AA} tidak';
  const text = list.length
    ? `\u{1F381} <b>BANSOS — ${family}</b> (${list.length} model)\n\n${note}`
    : `\u{1F381} <b>BANSOS — ${family}</b>\n\nUpstream tidak mengembalikan model untuk family ini. Kamu tetap bisa memilih seluruh family.`;
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Step 2: start (default now) and end (preset length, typed length or typed end time).
function adminBansosDurationView(draft, notice = '') {
  const rows = [];
  for (let i = 0; i < BANSOS_DURATIONS.length; i += 3) {
    rows.push(BANSOS_DURATIONS.slice(i, i + 3).map(([label, minutes]) => ({ text: label, callback_data: `admin_bsn_dur_${minutes}` })));
  }
  rows.push([{ text: '\u{1F552} Atur waktu mulai', callback_data: 'admin_bsn_start' }, { text: '\u{23F0} Atur waktu berakhir', callback_data: 'admin_bsn_end' }]);
  if (draft.startsAt) rows.push([{ text: '\u{25B6}\u{FE0F} Mulai sekarang saja', callback_data: 'admin_bsn_start_now' }]);
  if (draft.endsAt || draft.durationMs) rows.push([{ text: '\u{27A1}\u{FE0F} Lanjut: konfirmasi', callback_data: 'admin_bsn_confirm' }]);
  rows.push([{ text: '\u{1F519} Ubah model', callback_data: 'admin_bsn_targets' }, { text: '\u{274C} Batal', callback_data: 'admin_bsn_cancel' }]);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F381} <b>Buat BANSOS</b> — 2/3 Atur durasi',
    '',
    `Target: ${bansosTargetsText(draft, 12)}`,
    `Mulai: <b>${bansosStartText(draft)}</b>`,
    `Berakhir: <b>${bansosEndText(draft)}</b>`,
    '',
    'Pilih lama BANSOS (dihitung dari waktu mulai), atau atur waktu mulai/berakhir sendiri (WIB). Maksimal 90 hari.',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Step 3.
function adminBansosConfirmView(draft, notice = '') {
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F381} <b>Buat BANSOS</b> — 3/3 Konfirmasi',
    '',
    `Target: ${bansosTargetsText(draft, 20)}`,
    `Mulai: <b>${bansosStartText(draft)}</b>`,
    `Berakhir: <b>${bansosEndText(draft)}</b>`,
    '',
    'Selama BANSOS aktif, untuk model di atas:',
    '\u{2022} tarif <b>Rp0</b> (saldo & bonus token tidak terpotong)',
    '\u{2022} user dengan saldo Rp0 tetap bisa memakai',
    'Setelah waktu berakhir, harga & akses kembali normal otomatis.',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: draft.startsAt ? '\u{2705} Jadwalkan BANSOS' : '\u{2705} Mulai BANSOS', callback_data: 'admin_bsn_go' }],
    [{ text: '\u{1F519} Ubah durasi', callback_data: 'admin_bsn_next' }, { text: '\u{274C} Batal', callback_data: 'admin_bsn_cancel' }],
  ] } };
}

function promptBansosTime(chatId, userId, field) {
  const draft = bansosDraft(userId);
  pendingAdminBansos.set(String(userId), field);
  const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const base = draft?.startsAt ? Date.parse(draft.startsAt) : nextHour;
  const text = field === 'start'
    ? `\u{1F552} Kirim <b>waktu mulai</b> BANSOS (WIB), format <code>YYYY-MM-DD HH:MM</code> atau <code>DD/MM/YYYY HH:MM</code>.\nContoh: <code>${wibInputFormat(nextHour + 86_400_000)}</code>\nAtau kirim <code>sekarang</code> untuk mulai langsung.`
    : `\u{23F0} Kirim <b>waktu berakhir</b> BANSOS (WIB), format <code>YYYY-MM-DD HH:MM</code> atau <code>DD/MM/YYYY HH:MM</code>.\nContoh: <code>${wibInputFormat(base + 12 * 3_600_000)}</code>\nAtau kirim lamanya: <code>90m</code>, <code>6j</code>, <code>2hari</code> (dihitung dari waktu mulai).`;
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: 'admin_bsn_next' }]] },
  });
}

// Every admin_bsn* button. Returns the Telegram call to make.
async function handleBansosAction(query, action) {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  if (action === 'admin_bsn') {
    // Opened from the admin panel: a new message, like the other admin screens.
    const view = await adminBansosView();
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action === 'admin_bsn_list') return showAdminView(query, await adminBansosView());
  if (action.startsWith('admin_bsn_stop_')) {
    const stopped = await stopBansos(action.slice('admin_bsn_stop_'.length), userId);
    let notice = '\u{274C} BANSOS ini sudah berakhir atau tidak ditemukan.';
    if (stopped && Date.parse(stopped.stoppedAt) < Date.parse(stopped.startsAt)) {
      notice = `\u{1F5D1}\u{FE0F} BANSOS terjadwal <code>#${escapeHtml(stopped.id)}</code> dibatalkan.`;
    } else if (stopped) {
      notice = `\u{1F6D1} BANSOS <code>#${escapeHtml(stopped.id)}</code> dihentikan. Harga & akses modelnya kembali normal.`;
    }
    return showAdminView(query, await adminBansosView(notice));
  }
  if (action === 'admin_bsn_new') {
    bansosDrafts.set(userId, { models: [], families: [], startsAt: null, endsAt: null, durationMs: null });
    return showAdminView(query, await adminBansosTargetsView(userId));
  }
  if (action === 'admin_bsn_cancel') {
    bansosDrafts.delete(userId);
    return showAdminView(query, await adminBansosView('BANSOS baru dibatalkan.'));
  }

  const draft = bansosDraft(userId);
  if (!draft) {
    return showAdminView(query, await adminBansosView('\u{26A0}\u{FE0F} Draft BANSOS tidak ditemukan (mungkin bot baru restart). Mulai lagi dengan \u{2795} Buat BANSOS.'));
  }
  if (action === 'admin_bsn_targets') return showAdminView(query, await adminBansosTargetsView(userId));
  if (action.startsWith('admin_bsn_ft_')) {
    // Whole-family toggle, from the families list or (suffix "_in") from inside the family.
    const [indexText, where] = action.slice('admin_bsn_ft_'.length).split('_');
    const familyIndex = Number(indexText);
    const family = MODEL_FAMILIES[familyIndex];
    if (!family) return showAdminView(query, await adminBansosTargetsView(userId));
    draft.families = toggleIn(draft.families, family);
    return showAdminView(query, where === 'in' ? await adminBansosFamilyView(userId, familyIndex) : await adminBansosTargetsView(userId));
  }
  if (action.startsWith('admin_bsn_fam_')) {
    const familyIndex = Number(action.slice('admin_bsn_fam_'.length));
    if (!MODEL_FAMILIES[familyIndex]) return showAdminView(query, await adminBansosTargetsView(userId));
    return showAdminView(query, await adminBansosFamilyView(userId, familyIndex));
  }
  if (action.startsWith('admin_bsn_mt_')) {
    const [familyText, modelText] = action.slice('admin_bsn_mt_'.length).split('_');
    const familyIndex = Number(familyText);
    await ensureModelCache();
    const model = familyModels(familyIndex)[Number(modelText)];
    if (!model) return showAdminView(query, await adminBansosTargetsView(userId));
    // While the whole family is picked, single models cannot be toggled (the view says so).
    if (!draft.families.includes(MODEL_FAMILIES[familyIndex])) draft.models = toggleIn(draft.models, model.toLowerCase());
    return showAdminView(query, await adminBansosFamilyView(userId, familyIndex));
  }
  if (action === 'admin_bsn_next') {
    if (!draft.families.length && !draft.models.length) {
      return showAdminView(query, await adminBansosTargetsView(userId, '\u{26A0}\u{FE0F} Pilih minimal satu model atau family dulu.'));
    }
    return showAdminView(query, adminBansosDurationView(draft));
  }
  if (action.startsWith('admin_bsn_dur_')) {
    const minutes = Number(action.slice('admin_bsn_dur_'.length));
    if (!BANSOS_DURATIONS.some(([, value]) => value === minutes)) return showAdminView(query, adminBansosDurationView(draft));
    draft.durationMs = minutes * 60_000;
    draft.endsAt = null;
    return showAdminView(query, adminBansosConfirmView(draft));
  }
  if (action === 'admin_bsn_start' || action === 'admin_bsn_end') {
    return promptBansosTime(chatId, userId, action === 'admin_bsn_start' ? 'start' : 'end');
  }
  if (action === 'admin_bsn_start_now') {
    draft.startsAt = null;
    return showAdminView(query, adminBansosDurationView(draft, '\u{2705} BANSOS akan mulai saat dikonfirmasi.'));
  }
  if (action === 'admin_bsn_confirm') {
    if (!draft.endsAt && !draft.durationMs) return showAdminView(query, adminBansosDurationView(draft, '\u{26A0}\u{FE0F} Atur durasi atau waktu berakhir dulu.'));
    return showAdminView(query, adminBansosConfirmView(draft));
  }
  if (action === 'admin_bsn_go') {
    if (!draft.families.length && !draft.models.length) {
      return showAdminView(query, await adminBansosTargetsView(userId, '\u{26A0}\u{FE0F} Pilih minimal satu model atau family dulu.'));
    }
    if (!draft.endsAt && !draft.durationMs) return showAdminView(query, adminBansosDurationView(draft, '\u{26A0}\u{FE0F} Atur durasi atau waktu berakhir dulu.'));
    let created;
    try {
      created = await createBansos({
        // Single models of a family that is picked as a whole are already covered.
        models: draft.models.filter((model) => !draft.families.includes(getModelFamily(model))),
        families: draft.families,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        durationMs: draft.durationMs,
        createdBy: userId,
      });
    } catch (error) {
      return showAdminView(query, adminBansosConfirmView(draft, `\u{274C} ${escapeHtml(error.message)}`));
    }
    bansosDrafts.delete(userId);
    const notice = created.status === 'active'
      ? `\u{2705} BANSOS <code>#${escapeHtml(created.id)}</code> aktif sampai ${escapeHtml(wibTime(created.endsAt))}.`
      : `\u{2705} BANSOS <code>#${escapeHtml(created.id)}</code> dijadwalkan: ${escapeHtml(wibTime(created.startsAt))} \u{2192} ${escapeHtml(wibTime(created.endsAt))}.`;
    return showAdminView(query, await adminBansosView(notice));
  }
  return showAdminView(query, await adminBansosView());
}

// Typed start/end time for the BANSOS draft: saves it and shows the next step,
// or replies with what is wrong and keeps waiting for a corrected value.
async function handleBansosTimeInput(chatId, userId, text) {
  const field = pendingAdminBansos.get(userId);
  const draft = bansosDraft(userId);
  if (!draft) {
    pendingAdminBansos.delete(userId);
    const view = await adminBansosView('\u{26A0}\u{FE0F} Draft BANSOS tidak ditemukan (mungkin bot baru restart). Mulai lagi dengan \u{2795} Buat BANSOS.');
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  const now = Date.now();
  const reject = (reason) => telegram('sendMessage', { chat_id: chatId, text: `\u{274C} ${reason}`, parse_mode: 'HTML' });
  let view;
  if (field === 'start') {
    const startNow = /^(sekarang|now)$/i.test(text);
    const time = startNow ? null : parseWibDateTime(text);
    if (!startNow && time === null) return reject('Format tidak dikenali. Contoh: <code>2026-10-05 08:00</code>, atau <code>sekarang</code>.');
    if (!startNow && time <= now) return reject('Waktu mulai sudah lewat. Kirim waktu yang akan datang, atau <code>sekarang</code>.');
    if (!startNow && time - now > BANSOS_MAX_START_AHEAD_MS) return reject('Waktu mulai maksimal 365 hari dari sekarang.');
    pendingAdminBansos.delete(userId);
    draft.startsAt = startNow ? null : new Date(time).toISOString();
    let notice = '\u{2705} Waktu mulai disimpan.';
    // A typed end time that no longer comes after the new start has to be set again.
    if (draft.endsAt && Date.parse(draft.endsAt) - (time || now) < 60_000) {
      draft.endsAt = null;
      notice += ' Waktu berakhir sebelumnya jadi tidak valid, atur lagi.';
    }
    view = adminBansosDurationView(draft, notice);
  } else {
    const start = draft.startsAt ? Date.parse(draft.startsAt) : now;
    const duration = parseDurationText(text);
    const time = duration ? null : parseWibDateTime(text);
    if (!duration && time === null) return reject('Format tidak dikenali. Contoh: <code>2026-10-05 20:00</code>, <code>90m</code>, <code>6j</code>, atau <code>2hari</code>.');
    const length = duration || time - start;
    if (length < 60_000) return reject('Waktu berakhir harus minimal 1 menit setelah waktu mulai.');
    if (length > BANSOS_MAX_DURATION_MS) return reject('BANSOS maksimal 90 hari.');
    pendingAdminBansos.delete(userId);
    draft.durationMs = duration;
    draft.endsAt = duration ? null : new Date(time).toISOString();
    view = adminBansosConfirmView(draft);
  }
  return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
}

// ---------- Model access codes ----------
// Admin Panel -> Kode Akses Model. The admin picks one or more models and a period; the API server
// stores a unique, single-use code (MDL-XXXXXX-XXXXXX). The user who redeems it (Redeem Code or
// /redeem) gets extra access while the period runs: those models stay usable for them even when
// the admin has disabled them for everyone else (Disable Model), which makes them exclusive to
// code holders. Every other model keeps working as usual: a code never blocks anything. server.js
// checks every request and the extra access ends by itself once the period is over. Prices,
// balance, BANSOS and rate limits work as before. The API server checks the admin id again when
// a code is created or disabled, so these buttons are not the only gate. Model names, codes and user names always go
// through escapeHtml before they are put into an HTML message.

// [button label, minutes]
const ACCESS_DURATIONS = [
  ['1 jam', 60], ['6 jam', 360], ['1 hari', 1440],
  ['3 hari', 4320], ['7 hari', 10080], ['14 hari', 20160],
  ['30 hari', 43200], ['60 hari', 86400], ['90 hari', 129600],
];
// Same limits as usage-db.js, which checks them again.
const ACCESS_MIN_PERIOD_MS = 60_000;
const ACCESS_MAX_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;
const ACCESS_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const ACCESS_DEFAULT_REDEEM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_MAX_MODELS = 50;
const ACCESS_CODES_SHOWN = 10;
const ACCESS_INPUT_FIELDS = ['duration', 'expires', 'start', 'end'];
const ACCESS_STATUS_LABELS = {
  available: '\u{1F7E2} belum dipakai',
  in_use: '\u{1F535} sedang dipakai',
  scheduled: '\u{23F3} menunggu mulai',
  finished: '\u{2705} selesai',
  expired: '\u{231B} kedaluwarsa',
  disabled: '\u{1F6AB} dinonaktifkan',
  revoked: '\u{1F6D1} dihentikan admin',
};

// 90_060_000 -> "1 day 1 hour" (English counterpart of durationText).
function durationTextEn(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const unit = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [];
  if (days) parts.push(unit(days, 'day'));
  if (hours) parts.push(unit(hours, 'hour'));
  if (rest && !days) parts.push(unit(rest, 'minute'));
  return parts.join(' ') || '< 1 minute';
}

// What users read about model access codes, in their bot language.
const ACCESS_USER_TEXT = {
  id: {
    failures: {
      not_found: '\u{274C} Kode tidak ditemukan. Periksa kembali kodenya lalu coba lagi.',
      already_redeemed: '\u{26A0}\u{FE0F} Kamu sudah menukarkan kode ini.',
      used: '\u{26D4} Kode ini sudah dipakai. Setiap kode akses model hanya bisa ditukar satu kali.',
      disabled: '\u{1F6AB} Kode ini sudah dinonaktifkan oleh admin.',
      expired: '\u{231B} Kode ini sudah kedaluwarsa: batas penukaran atau periode aksesnya sudah lewat.',
      error: '\u{274C} Kode belum bisa ditukar saat ini. Coba lagi nanti.',
    },
    title: '\u{1F389} <b>Kode akses model berhasil ditukar!</b>',
    code: 'Kode',
    models: 'Model',
    period: 'Berlaku',
    scheduled: (start) => `\u{23F3} Akses khusus dimulai <b>${start}</b>. Sampai saat itu akses model kamu masih seperti biasa.`,
    combined: 'Bersama kode akses lain yang masih aktif, model akses khusus kamu sekarang',
    rule: '\u{2705} Selama periode ini kamu <b>bisa memakai model di atas</b>, termasuk saat model itu sedang ditutup untuk user lain. Model lain tetap bisa dipakai seperti biasa. Setelah periode berakhir, akses khusus ini selesai otomatis.',
    billing: '\u{1F4B3} Pemakaian tetap memotong saldo / bonus token sesuai harga model.',
    tryAnother: '\u{1F501} Coba kode lain',
    back: '\u{1F519} Kembali ke menu',
    cardTitle: '\u{1F510} <b>Kode Akses Model</b>',
    cardOnly: 'Akses khusus ke',
    cardUntil: 'sampai',
    cardStarts: 'mulai',
    notice: (models, until) => `\u{1F510} <b>Kode akses model aktif</b> sampai ${until}: kamu punya akses khusus ke ${models}. Model lain tetap bisa dipakai seperti biasa.`,
    stopped: (code) => `\u{1F6D1} Akses khusus dari kode <code>${code}</code> dihentikan oleh admin. Akses model kamu kembali seperti biasa.`,
    more: 'lainnya',
    length: durationText,
    left: (ms) => `sisa ${durationText(ms)}`,
  },
  en: {
    failures: {
      not_found: '\u{274C} Code not found. Check the code and try again.',
      already_redeemed: '\u{26A0}\u{FE0F} You have already redeemed this code.',
      used: '\u{26D4} This code has already been used. Each model access code can be redeemed only once.',
      disabled: '\u{1F6AB} This code has been disabled by the admin.',
      expired: '\u{231B} This code has expired: its redeem deadline or access period is over.',
      error: '\u{274C} This code cannot be redeemed right now. Please try again later.',
    },
    title: '\u{1F389} <b>Model access code redeemed!</b>',
    code: 'Code',
    models: 'Models',
    period: 'Valid',
    scheduled: (start) => `\u{23F3} Your extra access starts <b>${start}</b>. Until then your model access stays as usual.`,
    combined: 'Together with your other active access codes, your extra models now',
    rule: '\u{2705} During this period you <b>can use the models above</b>, even while they are closed for other users. All other models keep working as usual. When the period ends, this extra access ends automatically.',
    billing: '\u{1F4B3} Usage is still charged to your balance / bonus tokens at the model price.',
    tryAnother: '\u{1F501} Try another code',
    back: '\u{1F519} Back to menu',
    cardTitle: '\u{1F510} <b>Model Access Code</b>',
    cardOnly: 'Extra access to',
    cardUntil: 'until',
    cardStarts: 'starts',
    notice: (models, until) => `\u{1F510} <b>Model access code active</b> until ${until}: you have extra access to ${models}. All other models work as usual.`,
    stopped: (code) => `\u{1F6D1} The extra access from code <code>${code}</code> was stopped by the admin. Your model access is back to usual.`,
    more: 'more',
    length: durationTextEn,
    left: (ms) => `${durationTextEn(ms)} left`,
  },
};

function accessUserText(lang) {
  return ACCESS_USER_TEXT[lang] || ACCESS_USER_TEXT[DEFAULT_LANGUAGE];
}

function accessStatusLabel(status) {
  return ACCESS_STATUS_LABELS[status] || escapeHtml(status || '-');
}

// "<code>a</code> • <code>b</code> • +3 lainnya" (escaped), limited so long lists fit in a message.
function accessModelsText(models, limit = 6, more = 'lainnya') {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return '<i>belum ada</i>';
  const shown = list.slice(0, limit).map((model) => `<code>${escapeHtml(model)}</code>`).join(' \u{2022} ');
  return list.length > limit ? `${shown} \u{2022} +${list.length - limit} ${more}` : shown;
}

// How a code's (or a draft's) period is counted, for the admin screens.
function accessPeriodText(entry) {
  if (entry.kind === 'duration') {
    return entry.durationMs ? `${durationText(entry.durationMs)} sejak kode ditukar` : '<i>durasi belum diatur</i>';
  }
  const start = entry.startsAt ? escapeHtml(wibTime(entry.startsAt)) : 'saat kode dibuat';
  const end = entry.endsAt ? escapeHtml(wibTime(entry.endsAt)) : '<i>belum diatur</i>';
  return `${start} \u{2192} ${end}`;
}

function accessDeadlineText(draft) {
  if (draft.kind === 'range') return 'sampai periode berakhir';
  return draft.expiresAt
    ? escapeHtml(wibTime(draft.expiresAt))
    : `${durationText(ACCESS_DEFAULT_REDEEM_WINDOW_MS)} setelah kode dibuat (default)`;
}

function accessUserLabel(redemption) {
  const name = redemption.firstName || (redemption.username ? `@${redemption.username}` : `ID ${redemption.telegramId}`);
  return `<b>${escapeHtml(name)}</b> <code>${escapeHtml(redemption.telegramId)}</code>`;
}

function newAccessDraft() {
  return { models: [], kind: 'duration', durationMs: null, expiresAt: null, startsAt: null, endsAt: null };
}

function accessDraft(userId) {
  return accessCodeDrafts.get(String(userId)) || null;
}

function accessDraftComplete(draft) {
  return draft.models.length > 0 && (draft.kind === 'duration' ? Boolean(draft.durationMs) : Boolean(draft.endsAt));
}

// API Dashboard card for a user's active / upcoming access codes; '' when there are none.
function modelAccessCard(access, lang = DEFAULT_LANGUAGE) {
  if (!access || (!access.granted && !(access.scheduled || []).length)) return '';
  const t = accessUserText(lang);
  const now = Date.now();
  const lines = [];
  if (access.granted) {
    lines.push(`\u{2705} ${t.cardOnly}: ${accessModelsText(access.models, 12, t.more)}`);
    for (const grant of access.active.slice(0, 5)) {
      lines.push(`<code>${escapeHtml(grant.code)}</code> ${t.cardUntil} ${escapeHtml(wibTime(grant.endsAt))} (${t.left(Date.parse(grant.endsAt) - now)})`);
    }
  }
  for (const grant of (access.scheduled || []).slice(0, 5)) {
    lines.push(`\u{23F3} <code>${escapeHtml(grant.code)}</code> ${t.cardStarts} ${escapeHtml(wibTime(grant.startsAt))}: ${accessModelsText(grant.models, 4, t.more)}`);
  }
  return card(t.cardTitle, lines);
}

// One line for screens that list models (Model Price) while a code gives the user extra access.
function modelAccessNotice(access, lang = DEFAULT_LANGUAGE) {
  const t = accessUserText(lang);
  return t.notice(accessModelsText(access.models, 12, t.more), escapeHtml(wibTime(access.grantedUntil)));
}

// A user sent an MDL-... code (Redeem Code button, /redeem <code>, or just the code).
async function performAccessRedeem(chatId, from, rawCode) {
  const account = await getUser(from.id).catch(() => null);
  const t = accessUserText(userLanguage(account));
  let result;
  try {
    result = await redeemAccessCode(from.id, rawCode, { firstName: from.first_name, username: from.username });
  } catch (error) {
    // E.g. an API server that has no model access codes yet.
    console.error('[access-code] redeem failed:', error.message);
    result = { ok: false, reason: 'error' };
  }
  if (!result || !result.ok) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: t.failures[result?.reason] || t.failures.error,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: t.tryAnother, callback_data: 'redeem' }], [{ text: t.back, callback_data: 'menu' }]] },
    });
  }
  const length = Date.parse(result.endsAt) - Date.parse(result.startsAt);
  const allowed = result.access?.models || [];
  const lines = [
    t.title,
    '',
    `${t.code}: <code>${escapeHtml(result.code)}</code>`,
    `\u{1F916} ${t.models}: ${accessModelsText(result.models, ACCESS_MAX_MODELS, t.more)}`,
    `\u{1F552} ${t.period}: <b>${escapeHtml(wibTime(result.startsAt))}</b> \u{2192} <b>${escapeHtml(wibTime(result.endsAt))}</b> (${t.length(length)})`,
    ...(result.status === 'scheduled' ? ['', t.scheduled(escapeHtml(wibTime(result.startsAt)))] : []),
    ...(allowed.some((model) => !result.models.includes(model)) ? ['', `\u{2139}\u{FE0F} ${t.combined}: ${accessModelsText(allowed, 20, t.more)}`] : []),
    '',
    t.rule,
    t.billing,
  ];
  await telegram('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', reply_markup: menuKeyboard(from.id) });
  if (!isAdmin(from.id)) {
    const who = escapeHtml(from.first_name || from.username || from.id);
    await telegram('sendMessage', {
      chat_id: ADMIN_TELEGRAM_ID,
      text: [
        `\u{1F510} <b>${who}</b> (<code>${escapeHtml(from.id)}</code>) menukarkan kode akses <code>${escapeHtml(result.code)}</code>`,
        `Model: ${accessModelsText(result.models, 6)}`,
        `Akses: ${escapeHtml(wibTime(result.startsAt))} \u{2192} ${escapeHtml(wibTime(result.endsAt))}`,
      ].join('\n'),
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  return null;
}

// Main screen: what the feature does and the latest codes.
async function adminAccessCodesView(notice = '') {
  const codes = await listAccessCodes(ACCESS_CODES_SHOWN);
  const lines = [
    ...(notice ? [notice, ''] : []),
    '\u{1F510} <b>Kode Akses Model</b>',
    '',
    'Kode unik <b>sekali pakai</b> yang mengikat model pilihan dan periode. Selama periode berlaku, user yang menukarkannya <b>tetap bisa memakai model tersebut walaupun model itu di-disable</b> untuk user lain, jadi model itu eksklusif untuk pemegang kode. Model lain tetap bisa dipakai seperti biasa. Setelah periode selesai, akses khusus ini berakhir otomatis. Harga &amp; saldo tetap seperti biasa.',
    '',
    '<i>Cara pakai: disable model di menu Disable Model, lalu bagikan kode akses untuk model itu.</i>',
    '',
    codes.length ? `\u{1F4CB} <b>Kode terbaru</b> (${codes.length})` : '\u{1F4CB} Belum ada kode.',
    ...codes.map((entry) => [
      `<code>${escapeHtml(entry.code)}</code> ${accessStatusLabel(entry.status)}`,
      `   ${accessModelsText(entry.models, 3)}`,
      `   ${accessPeriodText(entry)}`,
    ].join('\n')),
  ];
  const rows = [[{ text: '\u{2795} Buat Kode', callback_data: 'admin_mac_new' }]];
  const detailButtons = codes.map((entry) => ({ text: `\u{1F50D} ${entry.code}`, callback_data: `admin_mac_v_${entry.code}` }));
  for (let i = 0; i < detailButtons.length; i += 2) rows.push(detailButtons.slice(i, i + 2));
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_mac_list' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function adminAccessCodeView(rawCode, notice = '') {
  const entry = await getAccessCode(rawCode);
  if (!entry) return adminAccessCodesView('\u{274C} Kode tidak ditemukan.');
  const redemption = entry.redemption;
  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F510} <b>Kode Akses</b> <code>${escapeHtml(entry.code)}</code>`,
    `Status: <b>${accessStatusLabel(entry.status)}</b>`,
    '',
    `\u{1F916} Model (${entry.models.length}): ${accessModelsText(entry.models, ACCESS_MAX_MODELS)}`,
    `\u{1F552} Periode: <b>${accessPeriodText(entry)}</b>`,
    `\u{23F3} Batas redeem: <b>${escapeHtml(wibTime(entry.expiresAt))}</b>`,
    `\u{1F4C5} Dibuat: ${escapeHtml(wibTime(entry.createdAt))}`,
  ];
  if (redemption) {
    lines.push(
      '',
      `\u{1F464} Ditukar oleh: ${accessUserLabel(redemption)}`,
      `   pada ${escapeHtml(wibTime(redemption.at))}`,
      `\u{1F510} Akses: ${escapeHtml(wibTime(redemption.startsAt))} \u{2192} ${escapeHtml(wibTime(redemption.endsAt))}`,
    );
    if (entry.status === 'in_use') lines.push(`   sisa ${durationText(Date.parse(redemption.endsAt) - Date.now())}`);
    if (redemption.revokedAt) lines.push(`\u{1F6D1} Dihentikan: ${escapeHtml(wibTime(redemption.revokedAt))}`);
  } else if (entry.disabledAt) {
    lines.push('', `\u{1F6AB} Dinonaktifkan: ${escapeHtml(wibTime(entry.disabledAt))}`);
  }
  const rows = [];
  if (entry.status === 'available') rows.push([{ text: '\u{1F6AB} Nonaktifkan kode', callback_data: `admin_mac_off_${entry.code}` }]);
  if (entry.status === 'in_use' || entry.status === 'scheduled') {
    rows.push([{ text: '\u{1F6D1} Hentikan akses user', callback_data: `admin_mac_off_${entry.code}` }]);
  }
  rows.push([{ text: '\u{1F519} Kembali ke daftar', callback_data: 'admin_mac_list' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// Step 1: one or more models, family by family.
async function adminAccessTargetsView(userId, notice = '') {
  const models = await ensureModelCache();
  const draft = accessDraft(userId);
  const familyButtons = MODEL_FAMILIES.map((family, index) => {
    const list = models.filter((model) => getModelFamily(model) === family);
    const picked = list.filter((model) => draft.models.includes(model.toLowerCase())).length;
    const icon = picked && picked === list.length ? '\u{2705}' : picked ? '\u{2611}\u{FE0F}' : '\u{26AA}';
    return { text: `${icon} ${family} (${picked}/${list.length})`, callback_data: `admin_mac_fam_${index}` };
  });
  const rows = [];
  for (let i = 0; i < familyButtons.length; i += 2) rows.push(familyButtons.slice(i, i + 2));
  if (draft.models.length) rows.push([{ text: '\u{1F9F9} Kosongkan pilihan', callback_data: 'admin_mac_clear' }]);
  rows.push([{ text: '\u{27A1}\u{FE0F} Lanjut: atur periode', callback_data: 'admin_mac_next' }]);
  rows.push([{ text: '\u{274C} Batal', callback_data: 'admin_mac_cancel' }]);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F510} <b>Buat Kode Akses</b> \u{2014} 1/3 Pilih model',
    '',
    `Tap family untuk memilih modelnya (satu atau lebih, maks. ${ACCESS_MAX_MODELS}). User yang menukarkan kode bisa memakai model yang dipilih di sini walaupun model itu di-disable untuk user lain.`,
    '\u{2705} semua model family \u{2022} \u{2611}\u{FE0F} sebagian \u{2022} \u{26AA} belum dipilih',
    '',
    `Dipilih (${draft.models.length}): ${accessModelsText(draft.models, 12)}`,
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

async function adminAccessFamilyView(userId, familyIndex, notice = '') {
  await ensureModelCache();
  const family = MODEL_FAMILIES[familyIndex];
  const list = familyModels(familyIndex);
  const draft = accessDraft(userId);
  const buttons = list.map((model, modelIndex) => {
    const picked = draft.models.includes(model.toLowerCase());
    return { text: `${picked ? '\u{2705}' : '\u{26AA}'} ${model}`.slice(0, 60), callback_data: `admin_mac_mt_${familyIndex}_${modelIndex}` };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  if (list.length) {
    rows.push([
      { text: `\u{2705} Pilih semua ${family}`, callback_data: `admin_mac_fall_${familyIndex}` },
      { text: '\u{2716}\u{FE0F} Hapus semua', callback_data: `admin_mac_fnone_${familyIndex}` },
    ]);
  }
  rows.push([{ text: '\u{1F519} Kembali ke family', callback_data: 'admin_mac_targets' }]);
  const body = list.length
    ? `\u{1F510} <b>Kode Akses \u{2014} ${escapeHtml(family)}</b> (${list.length} model)\n\nTap model untuk pilih/batal. \u{2705} dipilih \u{2022} \u{26AA} tidak\nTotal dipilih: <b>${draft.models.length}</b>/${ACCESS_MAX_MODELS}`
    : `\u{1F510} <b>Kode Akses \u{2014} ${escapeHtml(family)}</b>\n\nUpstream tidak mengembalikan model untuk family ini. Coba Resync models di menu Disable Model.`;
  return { text: notice ? `${notice}\n\n${body}` : body, reply_markup: { inline_keyboard: rows } };
}

// Step 2: how the period is counted, and its length / window.
function adminAccessPeriodView(draft, notice = '') {
  const isDuration = draft.kind === 'duration';
  const rows = [[
    { text: `${isDuration ? '\u{2705} ' : ''}\u{23F1}\u{FE0F} Durasi sejak ditukar`, callback_data: 'admin_mac_kind_dur' },
    { text: `${isDuration ? '' : '\u{2705} '}\u{1F4C5} Rentang waktu tetap`, callback_data: 'admin_mac_kind_rng' },
  ]];
  let settings;
  if (isDuration) {
    for (let i = 0; i < ACCESS_DURATIONS.length; i += 3) {
      rows.push(ACCESS_DURATIONS.slice(i, i + 3).map(([label, minutes]) => ({
        text: `${draft.durationMs === minutes * 60_000 ? '\u{2705} ' : ''}${label}`,
        callback_data: `admin_mac_dur_${minutes}`,
      })));
    }
    rows.push([{ text: '\u{270F}\u{FE0F} Ketik durasi', callback_data: 'admin_mac_in_duration' }, { text: '\u{23F3} Atur batas redeem', callback_data: 'admin_mac_in_expires' }]);
    if (draft.expiresAt) rows.push([{ text: '\u{21A9}\u{FE0F} Batas redeem default', callback_data: 'admin_mac_exp_default' }]);
    settings = [
      `Durasi akses: <b>${draft.durationMs ? durationText(draft.durationMs) : '<i>belum diatur</i>'}</b>`,
      `Batas redeem: <b>${accessDeadlineText(draft)}</b>`,
    ];
  } else {
    rows.push([{ text: '\u{1F552} Atur waktu mulai', callback_data: 'admin_mac_in_start' }, { text: '\u{23F0} Atur waktu berakhir', callback_data: 'admin_mac_in_end' }]);
    if (draft.startsAt) rows.push([{ text: '\u{25B6}\u{FE0F} Mulai sekarang saja', callback_data: 'admin_mac_start_now' }]);
    settings = [
      `Mulai: <b>${draft.startsAt ? escapeHtml(wibTime(draft.startsAt)) : 'Sekarang (saat kode dibuat)'}</b>`,
      `Berakhir: <b>${draft.endsAt ? escapeHtml(wibTime(draft.endsAt)) : '<i>belum diatur</i>'}</b>`,
    ];
  }
  if (accessDraftComplete(draft)) rows.push([{ text: '\u{27A1}\u{FE0F} Lanjut: konfirmasi', callback_data: 'admin_mac_confirm' }]);
  rows.push([{ text: '\u{1F519} Ubah model', callback_data: 'admin_mac_targets' }, { text: '\u{274C} Batal', callback_data: 'admin_mac_cancel' }]);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F510} <b>Buat Kode Akses</b> \u{2014} 2/3 Atur periode',
    '',
    `Model (${draft.models.length}): ${accessModelsText(draft.models, 8)}`,
    '',
    '\u{23F1}\u{FE0F} <b>Durasi sejak ditukar</b>: masa akses mulai saat user menukarkan kode. Kode bisa ditukar sampai batas redeem.',
    '\u{1F4C5} <b>Rentang waktu tetap</b>: akses hanya berlaku antara waktu mulai &amp; berakhir (WIB), kapan pun kode ditukar. Lewat waktu berakhir, kode kedaluwarsa.',
    '',
    ...settings,
    '',
    `<i>Periode maksimal ${durationText(ACCESS_MAX_PERIOD_MS)}.</i>`,
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Step 3.
async function adminAccessConfirmView(draft, notice = '') {
  // Exclusive = disabled for everyone else right now; the others are open to all users anyway.
  const disabled = await getDisabledModels().catch(() => null);
  const off = disabled ? draft.models.filter((model) => isDisabledIn(disabled, model)) : [];
  const open = draft.models.filter((model) => !off.includes(model));
  const status = [];
  if (off.length) status.push(`\u{1F512} Eksklusif (sedang di-disable untuk user lain, pemegang kode tetap bisa pakai): ${accessModelsText(off, 10)}`);
  if (open.length) status.push(`\u{2139}\u{FE0F} Sedang terbuka untuk semua user: ${accessModelsText(open, 10)}. Kode baru terasa manfaatnya untuk model ini kalau model itu di-disable di menu <b>Disable Model</b>.`);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F510} <b>Buat Kode Akses</b> \u{2014} 3/3 Konfirmasi',
    '',
    `\u{1F916} Model (${draft.models.length}): ${accessModelsText(draft.models, ACCESS_MAX_MODELS)}`,
    `\u{1F552} Periode: <b>${accessPeriodText(draft)}</b>`,
    `\u{23F3} Batas redeem: <b>${accessDeadlineText(draft)}</b>`,
    ...(status.length ? ['', ...status] : []),
    '',
    'Kode ini <b>sekali pakai</b> (1 user). Selama periode akses, user itu <b>bisa memakai model di atas</b> lewat API walaupun model itu di-disable untuk user lain. Model lain tetap bisa dipakai seperti biasa (tidak dibatasi). Setelah periode berakhir, akses khusus ini selesai otomatis.',
    '<i>Harga, saldo, bonus token, BANSOS dan rate limit tetap berlaku seperti biasa.</i>',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: '\u{2705} Buat kode', callback_data: 'admin_mac_go' }],
    [{ text: '\u{1F519} Ubah periode', callback_data: 'admin_mac_next' }, { text: '\u{274C} Batal', callback_data: 'admin_mac_cancel' }],
  ] } };
}

function adminAccessCreatedView(entry) {
  const text = [
    '\u{2705} <b>Kode akses dibuat!</b>',
    '',
    `Kode: <code>${escapeHtml(entry.code)}</code>`,
    `\u{1F916} Model (${entry.models.length}): ${accessModelsText(entry.models, ACCESS_MAX_MODELS)}`,
    `\u{1F552} Periode: <b>${accessPeriodText(entry)}</b>`,
    `\u{23F3} Batas redeem: <b>${escapeHtml(wibTime(entry.expiresAt))}</b>`,
    '',
    'Tap kode untuk copy, lalu kirim ke user. User menukarkannya lewat <b>Redeem Code</b> di menu, atau dengan:',
    `<code>/redeem ${escapeHtml(entry.code)}</code>`,
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: '\u{2795} Buat 1 lagi (pengaturan sama)', callback_data: 'admin_mac_again' }],
    [{ text: '\u{1F4CB} Daftar kode', callback_data: 'admin_mac_list' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }],
  ] } };
}

function promptAccessInput(chatId, userId, field) {
  const draft = accessDraft(userId);
  pendingAdminAccess.set(String(userId), field);
  const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const base = draft?.startsAt ? Date.parse(draft.startsAt) : nextHour;
  const formats = 'format <code>YYYY-MM-DD HH:MM</code> atau <code>DD/MM/YYYY HH:MM</code>';
  const texts = {
    duration: '\u{270F}\u{FE0F} Kirim <b>durasi akses</b> (dihitung sejak user menukarkan kode), contoh <code>90m</code>, <code>12j</code>, <code>45hari</code>. Maksimal 365 hari.',
    expires: `\u{23F3} Kirim <b>batas redeem</b> (WIB), ${formats}.\nContoh: <code>${wibInputFormat(nextHour + 7 * 86_400_000)}</code>\nAtau lamanya dari sekarang: <code>12j</code>, <code>7hari</code>. Setelah batas ini kode tidak bisa ditukar lagi.`,
    start: `\u{1F552} Kirim <b>waktu mulai</b> akses (WIB), ${formats}.\nContoh: <code>${wibInputFormat(nextHour + 86_400_000)}</code>\nAtau kirim <code>sekarang</code>.`,
    end: `\u{23F0} Kirim <b>waktu berakhir</b> akses (WIB), ${formats}.\nContoh: <code>${wibInputFormat(base + 7 * 86_400_000)}</code>\nAtau lamanya dari waktu mulai: <code>12j</code>, <code>7hari</code>.`,
  };
  return telegram('sendMessage', {
    chat_id: chatId,
    text: texts[field],
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: 'admin_mac_next' }]] },
  });
}

// Typed value for the draft (see promptAccessInput): saves it and shows the next step, or replies
// with what is wrong and keeps waiting for a corrected value.
async function handleAccessCodeInput(chatId, userId, text) {
  const field = pendingAdminAccess.get(userId);
  const draft = accessDraft(userId);
  const send = (view) => telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  if (!draft) {
    pendingAdminAccess.delete(userId);
    return send(await adminAccessCodesView('\u{26A0}\u{FE0F} Draft kode akses tidak ditemukan (mungkin bot baru restart). Mulai lagi dengan \u{2795} Buat Kode.'));
  }
  const reject = (reason) => telegram('sendMessage', { chat_id: chatId, text: `\u{274C} ${reason}`, parse_mode: 'HTML' });
  const value = text.trim();
  const now = Date.now();
  if (field === 'duration') {
    const duration = parseDurationText(value);
    if (!duration) return reject('Format tidak dikenali. Contoh: <code>90m</code>, <code>12j</code>, <code>45hari</code>.');
    if (duration < ACCESS_MIN_PERIOD_MS) return reject('Durasi akses minimal 1 menit.');
    if (duration > ACCESS_MAX_PERIOD_MS) return reject('Durasi akses maksimal 365 hari.');
    pendingAdminAccess.delete(userId);
    draft.kind = 'duration';
    draft.durationMs = duration;
    return send(await adminAccessConfirmView(draft));
  }
  if (field === 'expires') {
    const length = parseDurationText(value);
    const time = length ? now + length : parseWibDateTime(value);
    if (time === null) return reject('Format tidak dikenali. Contoh: <code>2026-10-20 23:59</code>, <code>12j</code> atau <code>7hari</code>.');
    if (time - now < ACCESS_MIN_PERIOD_MS) return reject('Batas redeem harus minimal 1 menit dari sekarang.');
    if (time - now > ACCESS_MAX_AHEAD_MS) return reject('Batas redeem maksimal 365 hari dari sekarang.');
    pendingAdminAccess.delete(userId);
    draft.expiresAt = new Date(time).toISOString();
    return send(adminAccessPeriodView(draft, '\u{2705} Batas redeem disimpan.'));
  }
  if (field === 'start') {
    const startNow = /^(sekarang|now)$/i.test(value);
    const time = startNow ? null : parseWibDateTime(value);
    if (!startNow && time === null) return reject('Format tidak dikenali. Contoh: <code>2026-10-05 08:00</code>, atau <code>sekarang</code>.');
    if (!startNow && time <= now) return reject('Waktu mulai sudah lewat. Kirim waktu yang akan datang, atau <code>sekarang</code>.');
    if (!startNow && time - now > ACCESS_MAX_AHEAD_MS) return reject('Waktu mulai maksimal 365 hari dari sekarang.');
    pendingAdminAccess.delete(userId);
    draft.kind = 'range';
    draft.startsAt = startNow ? null : new Date(time).toISOString();
    let notice = '\u{2705} Waktu mulai disimpan.';
    // A typed end time that no longer fits the new start has to be set again.
    const length = draft.endsAt ? Date.parse(draft.endsAt) - (time || now) : 0;
    if (draft.endsAt && (length < ACCESS_MIN_PERIOD_MS || length > ACCESS_MAX_PERIOD_MS)) {
      draft.endsAt = null;
      notice += ' Waktu berakhir sebelumnya jadi tidak valid, atur lagi.';
    }
    return send(adminAccessPeriodView(draft, notice));
  }
  if (field === 'end') {
    const start = draft.startsAt ? Date.parse(draft.startsAt) : now;
    const length = parseDurationText(value);
    const time = length ? start + length : parseWibDateTime(value);
    if (time === null) return reject('Format tidak dikenali. Contoh: <code>2026-10-12 20:00</code>, <code>12j</code> atau <code>7hari</code>.');
    if (time <= now) return reject('Waktu berakhir sudah lewat.');
    if (time - start < ACCESS_MIN_PERIOD_MS) return reject('Waktu berakhir harus minimal 1 menit setelah waktu mulai.');
    if (time - start > ACCESS_MAX_PERIOD_MS) return reject('Periode akses maksimal 365 hari.');
    pendingAdminAccess.delete(userId);
    draft.kind = 'range';
    draft.endsAt = new Date(time).toISOString();
    return send(await adminAccessConfirmView(draft));
  }
  pendingAdminAccess.delete(userId);
  return send(adminAccessPeriodView(draft));
}

// Every admin_mac* button (admin-only: checked for every admin_ action before this runs, and again
// by the API server for creating / disabling). Returns the Telegram call to make.
async function handleAccessCodeAction(query, action) {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  if (action === 'admin_mac') {
    // Opened from the admin panel: a new message, like the other admin screens.
    const view = await adminAccessCodesView();
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action === 'admin_mac_list') return showAdminView(query, await adminAccessCodesView());
  if (action.startsWith('admin_mac_v_')) return showAdminView(query, await adminAccessCodeView(action.slice('admin_mac_v_'.length)));
  if (action.startsWith('admin_mac_offok_')) {
    const result = await disableAccessCode(action.slice('admin_mac_offok_'.length), userId);
    if (!result) return showAdminView(query, await adminAccessCodesView('\u{274C} Kode tidak ditemukan.'));
    let notice = 'Kode ini sudah tidak aktif, tidak ada yang diubah.';
    if (result.changed && result.previousStatus === 'available') {
      notice = '\u{1F6AB} Kode dinonaktifkan dan tidak bisa ditukar lagi.';
    } else if (result.changed) {
      notice = '\u{1F6D1} Akses khusus dihentikan. Akses model user kembali seperti biasa.';
      const target = result.code.redemption?.telegramId;
      if (target) {
        const account = await getUser(target).catch(() => null);
        await telegram('sendMessage', {
          chat_id: target,
          text: accessUserText(userLanguage(account)).stopped(escapeHtml(result.code.code)),
          parse_mode: 'HTML',
          reply_markup: menuKeyboard(target),
        }).catch(() => {});
      }
    }
    return showAdminView(query, await adminAccessCodeView(result.code.code, notice));
  }
  if (action.startsWith('admin_mac_off_')) {
    // Two-step: this only asks; the change runs on the confirm button.
    const entry = await getAccessCode(action.slice('admin_mac_off_'.length));
    if (!entry) return showAdminView(query, await adminAccessCodesView('\u{274C} Kode tidak ditemukan.'));
    const running = entry.status === 'in_use' || entry.status === 'scheduled';
    if (!running && entry.status !== 'available') return showAdminView(query, await adminAccessCodeView(entry.code, 'Kode ini sudah tidak aktif.'));
    const code = escapeHtml(entry.code);
    const text = running
      ? `\u{1F6D1} Hentikan akses dari kode <code>${code}</code> sekarang?\n\n${accessUserLabel(entry.redemption)} kehilangan akses khusus dari kode ini: model yang di-disable tidak bisa dipakainya lagi (kecuali masih ada di kode akses lain yang aktif). Model lain tidak terpengaruh. Tidak bisa dibatalkan.`
      : `\u{1F6AB} Nonaktifkan kode <code>${code}</code>?\n\nKode tidak bisa ditukar lagi. Tidak bisa dibatalkan.`;
    return showAdminView(query, { text, reply_markup: { inline_keyboard: [[
      { text: running ? '\u{2705} Ya, hentikan' : '\u{2705} Ya, nonaktifkan', callback_data: `admin_mac_offok_${entry.code}` },
      { text: '\u{274C} Batal', callback_data: `admin_mac_v_${entry.code}` },
    ]] } });
  }
  if (action === 'admin_mac_new') {
    accessCodeDrafts.set(userId, newAccessDraft());
    return showAdminView(query, await adminAccessTargetsView(userId));
  }
  if (action === 'admin_mac_cancel') {
    accessCodeDrafts.delete(userId);
    return showAdminView(query, await adminAccessCodesView('Pembuatan kode dibatalkan.'));
  }

  const draft = accessDraft(userId);
  if (!draft) {
    return showAdminView(query, await adminAccessCodesView('\u{26A0}\u{FE0F} Draft kode akses tidak ditemukan (mungkin bot baru restart). Mulai lagi dengan \u{2795} Buat Kode.'));
  }
  if (action === 'admin_mac_targets') return showAdminView(query, await adminAccessTargetsView(userId));
  if (action === 'admin_mac_clear') {
    draft.models = [];
    return showAdminView(query, await adminAccessTargetsView(userId));
  }
  if (action.startsWith('admin_mac_fam_')) {
    const familyIndex = Number(action.slice('admin_mac_fam_'.length));
    if (!MODEL_FAMILIES[familyIndex]) return showAdminView(query, await adminAccessTargetsView(userId));
    return showAdminView(query, await adminAccessFamilyView(userId, familyIndex));
  }
  if (action.startsWith('admin_mac_mt_')) {
    const [familyText, modelText] = action.slice('admin_mac_mt_'.length).split('_');
    const familyIndex = Number(familyText);
    await ensureModelCache();
    const model = MODEL_FAMILIES[familyIndex] ? familyModels(familyIndex)[Number(modelText)] : undefined;
    if (!model) return showAdminView(query, await adminAccessTargetsView(userId));
    const key = model.toLowerCase();
    if (!draft.models.includes(key) && draft.models.length >= ACCESS_MAX_MODELS) {
      return showAdminView(query, await adminAccessFamilyView(userId, familyIndex, `\u{26A0}\u{FE0F} Maksimal ${ACCESS_MAX_MODELS} model per kode.`));
    }
    draft.models = toggleIn(draft.models, key);
    return showAdminView(query, await adminAccessFamilyView(userId, familyIndex));
  }
  if (action.startsWith('admin_mac_fall_') || action.startsWith('admin_mac_fnone_')) {
    const all = action.startsWith('admin_mac_fall_');
    const familyIndex = Number(action.slice((all ? 'admin_mac_fall_' : 'admin_mac_fnone_').length));
    if (!MODEL_FAMILIES[familyIndex]) return showAdminView(query, await adminAccessTargetsView(userId));
    await ensureModelCache();
    const keys = familyModels(familyIndex).map((model) => model.toLowerCase());
    let notice = '';
    if (!all) {
      draft.models = draft.models.filter((key) => !keys.includes(key));
    } else {
      const merged = [...new Set([...draft.models, ...keys])];
      if (merged.length > ACCESS_MAX_MODELS) notice = `\u{26A0}\u{FE0F} Maksimal ${ACCESS_MAX_MODELS} model per kode: pilih model satu per satu.`;
      else draft.models = merged;
    }
    return showAdminView(query, await adminAccessFamilyView(userId, familyIndex, notice));
  }
  if (action === 'admin_mac_next') {
    if (!draft.models.length) return showAdminView(query, await adminAccessTargetsView(userId, '\u{26A0}\u{FE0F} Pilih minimal satu model dulu.'));
    return showAdminView(query, adminAccessPeriodView(draft));
  }
  if (action === 'admin_mac_kind_dur' || action === 'admin_mac_kind_rng') {
    draft.kind = action === 'admin_mac_kind_dur' ? 'duration' : 'range';
    return showAdminView(query, adminAccessPeriodView(draft));
  }
  if (action.startsWith('admin_mac_dur_')) {
    const minutes = Number(action.slice('admin_mac_dur_'.length));
    if (!ACCESS_DURATIONS.some(([, value]) => value === minutes)) return showAdminView(query, adminAccessPeriodView(draft));
    draft.kind = 'duration';
    draft.durationMs = minutes * 60_000;
    return showAdminView(query, await adminAccessConfirmView(draft));
  }
  if (action.startsWith('admin_mac_in_')) {
    const field = action.slice('admin_mac_in_'.length);
    if (!ACCESS_INPUT_FIELDS.includes(field)) return showAdminView(query, adminAccessPeriodView(draft));
    return promptAccessInput(chatId, userId, field);
  }
  if (action === 'admin_mac_start_now') {
    draft.startsAt = null;
    return showAdminView(query, adminAccessPeriodView(draft, '\u{2705} Akses mulai saat kode dibuat.'));
  }
  if (action === 'admin_mac_exp_default') {
    draft.expiresAt = null;
    return showAdminView(query, adminAccessPeriodView(draft, '\u{2705} Batas redeem kembali ke default.'));
  }
  if (action === 'admin_mac_confirm') {
    if (!accessDraftComplete(draft)) return showAdminView(query, adminAccessPeriodView(draft, '\u{26A0}\u{FE0F} Atur periode dulu.'));
    return showAdminView(query, await adminAccessConfirmView(draft));
  }
  if (action === 'admin_mac_go' || action === 'admin_mac_again') {
    // "Again" posts a new message, so the code made before stays on screen to be copied.
    const show = action === 'admin_mac_again'
      ? (view) => telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup })
      : (view) => showAdminView(query, view);
    if (!draft.models.length) return show(await adminAccessTargetsView(userId, '\u{26A0}\u{FE0F} Pilih minimal satu model dulu.'));
    if (!accessDraftComplete(draft)) return show(adminAccessPeriodView(draft, '\u{26A0}\u{FE0F} Atur periode dulu.'));
    let created;
    try {
      created = await createAccessCode({
        models: draft.models,
        kind: draft.kind,
        ...(draft.kind === 'duration'
          ? { durationMs: draft.durationMs, expiresAt: draft.expiresAt }
          : { startsAt: draft.startsAt, endsAt: draft.endsAt }),
        createdBy: userId,
      });
    } catch (error) {
      return show(await adminAccessConfirmView(draft, `\u{274C} ${escapeHtml(error.message)}`));
    }
    // The draft is kept so "Buat 1 lagi" can make another code with the same settings.
    return show(adminAccessCreatedView(created));
  }
  return showAdminView(query, await adminAccessCodesView());
}

// ---------- Referral ----------

async function getBotUsername() {
  if (!botUsername) botUsername = (await telegram('getMe')).username || '';
  return botUsername;
}

// Accepts "10000000", "10.000.000", "10M", "1,5jt", "500k", "500rb".
function parseTokenAmount(text) {
  const raw = String(text || '').trim().toLowerCase().replace(/\s+/g, '').replace(/tokens?$/, '');
  const suffixed = raw.match(/^(\d+(?:[.,]\d+)?)(m|jt|juta|k|rb|ribu)$/);
  if (suffixed) {
    const multiplier = ['m', 'jt', 'juta'].includes(suffixed[2]) ? 1_000_000 : 1_000;
    const value = Math.round(Number(suffixed[1].replace(',', '.')) * multiplier);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (!/^\d[\d.,]*$/.test(raw)) return null;
  const value = Number(raw.replace(/[.,]/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

async function referralView(from) {
  const info = await getReferralInfo(from.id, { firstName: from.first_name, username: from.username });
  const { settings } = info;
  const link = `https://t.me/${await getBotUsername()}?start=${info.code}`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Join ${STORE_NAME} for API tokens!`)}`;
  const lines = [
    '\u{1F91D} <b>Referral</b>',
    '',
    settings.enabled
      ? `Ajak teman! Setiap user <b>baru</b> yang start bot lewat link kamu = \u{1F381} <b>+${formatTokens(settings.rewardTokens)}</b> bonus token untuk kamu.`
      : '\u{1F6A7} Program referral sedang <b>nonaktif</b>. Undangan baru belum dapat hadiah.',
    ...(settings.enabled && settings.maxRewardsPerUser ? [`Maks. <b>${formatTokens(settings.maxRewardsPerUser)}</b> undangan berhadiah per user.`] : []),
    '',
    `\u{1F517} Link kamu:\n<code>${escapeHtml(link)}</code>`,
    '',
    `\u{1F465} Diundang: <b>${formatTokens(info.invites)}</b> (berhadiah ${formatTokens(info.rewardedInvites)})`,
    `\u{1F381} Token didapat: <b>${formatTokens(info.tokensEarned)}</b>`,
    `\u{1F48E} Sisa bonus token: <b>${formatTokens(info.bonusTokens)}</b>`,
    '',
    '<i>Bonus token dipakai duluan (sebelum saldo Rp) untuk model berbayar. Hanya akun Telegram yang belum pernah memakai bot ini yang dihitung.</i>',
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [
    [{ text: '\u{1F4E4} Share link', url: share }],
    [{ text: '\u{1F519} Back to menu', callback_data: 'menu' }],
  ] } };
}

async function adminReferralView(notice = '') {
  const settings = await getReferralSettings();
  const referrers = (await getAllUsers()).filter((user) => Number(user.referralStats?.invites || 0) > 0);
  const totals = referrers.reduce((sum, user) => ({
    invites: sum.invites + Number(user.referralStats.invites || 0),
    rewarded: sum.rewarded + Number(user.referralStats.rewarded || 0),
    tokens: sum.tokens + Number(user.referralStats.tokensEarned || 0),
  }), { invites: 0, rewarded: 0, tokens: 0 });
  const top = referrers
    .sort((a, b) => Number(b.referralStats.invites || 0) - Number(a.referralStats.invites || 0)
      || Number(b.referralStats.tokensEarned || 0) - Number(a.referralStats.tokensEarned || 0))
    .slice(0, 10)
    .map((user, index) => `${index + 1}. ${escapeHtml(user.firstName || user.username || user.telegramId)} <code>${escapeHtml(user.telegramId)}</code>\n   \u{1F465} ${formatTokens(user.referralStats.invites)} invite • \u{1F381} ${formatTokens(user.referralStats.tokensEarned || 0)} tok • \u{1F48E} left ${formatTokens(user.bonusTokens || 0)}`);
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F91D} <b>Referral Settings</b>',
    '',
    `• Status: <b>${settings.enabled ? '\u{1F7E2} ON' : '\u{1F534} OFF'}</b>`,
    `• Reward: <b>${formatTokens(settings.rewardTokens)}</b> bonus tokens per new user`,
    `• Max rewarded invites per user: <b>${settings.maxRewardsPerUser ? formatTokens(settings.maxRewardsPerUser) : 'unlimited'}</b>`,
    '',
    '\u{1F4CA} <b>Stats</b>',
    `• Invites: <b>${formatTokens(totals.invites)}</b> (rewarded ${formatTokens(totals.rewarded)})`,
    `• Tokens awarded: <b>${formatTokens(totals.tokens)}</b>`,
    '',
    '\u{1F3C6} <b>Top referrers</b>',
    top.length ? top.join('\n') : 'No referrals yet.',
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: settings.enabled ? '\u{1F534} Disable Referral' : '\u{1F7E2} Enable Referral', callback_data: 'admin_ref_toggle' }],
    [{ text: '\u{1F381} Set Reward', callback_data: 'admin_ref_reward' }, { text: '\u{1F522} Max per User', callback_data: 'admin_ref_cap' }],
    [{ text: '\u{1F504} Refresh', callback_data: 'admin_ref' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }],
  ] } };
}

function adminReferralRewardView(current) {
  const pick = (value) => ({ text: formatTokens(value), callback_data: `admin_ref_rw_${value}` });
  return {
    text: `\u{1F381} <b>Referral reward</b>\nNow: <b>${formatTokens(current)}</b> tokens per new user\n\nPick an amount or type one (e.g. <code>10000000</code>, <code>10M</code>, <code>500k</code>).`,
    reply_markup: { inline_keyboard: [
      [pick(1_000_000), pick(5_000_000)],
      [pick(10_000_000), pick(20_000_000)],
      [{ text: '\u{274C} Cancel', callback_data: 'admin_ref' }],
    ] },
  };
}

function adminReferralCapView(current) {
  const pick = (value) => ({ text: value ? formatTokens(value) : 'Unlimited', callback_data: `admin_ref_cp_${value}` });
  return {
    text: `\u{1F522} <b>Max rewarded invites per user</b>\nNow: <b>${current ? formatTokens(current) : 'unlimited'}</b>\n\nPick a value or type a number (<code>0</code> = unlimited). Invites past the cap are still counted, but earn no tokens.`,
    reply_markup: { inline_keyboard: [
      [pick(0), pick(5), pick(10)],
      [pick(25), pick(50), pick(100)],
      [{ text: '\u{274C} Cancel', callback_data: 'admin_ref' }],
    ] },
  };
}

// Tells the new user and the inviter what happened with a /start <code>.
async function announceReferral(chatId, referral, lang = DEFAULT_LANGUAGE) {
  await greetReferredUser(chatId, referral, lang);
  await notifyReferrer(referral);
}

// The new user's side of a referral, in their chosen language.
async function greetReferredUser(chatId, referral, lang = DEFAULT_LANGUAGE) {
  if (!referral) return;
  const en = lang === 'en';
  if (referral.reason === 'self') {
    const text = en ? '\u{2139}\u{FE0F} You cannot use your own referral link.' : '\u{2139}\u{FE0F} Kamu tidak bisa memakai link referral milik sendiri.';
    await telegram('sendMessage', { chat_id: chatId, text }).catch(() => {});
    return;
  }
  if (referral.reason === 'not_new') {
    const text = en
      ? '\u{2139}\u{FE0F} Referral links only work for new users. Your account was already registered.'
      : '\u{2139}\u{FE0F} Link referral hanya berlaku untuk user baru. Akun kamu sudah terdaftar sebelumnya.';
    await telegram('sendMessage', { chat_id: chatId, text }).catch(() => {});
    return;
  }
  if (referral.reason !== 'credited' && referral.reason !== 'cap_reached') return;
  const inviter = referral.referrerName ? ` <b>${escapeHtml(referral.referrerName)}</b>` : '';
  const text = en ? `\u{1F91D} You joined through an invite${inviter ? ` from${inviter}` : ''}. Welcome!` : `\u{1F91D} Kamu bergabung lewat undangan${inviter}. Selamat datang!`;
  await telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch(() => {});
}

// The inviter's side of a referral (unchanged text).
async function notifyReferrer(referral) {
  if (!referral || (referral.reason !== 'credited' && referral.reason !== 'cap_reached')) return;
  const text = referral.credited
    ? `\u{1F389} <b>Referral baru!</b>\n\nSeorang user baru bergabung lewat link kamu.\nHadiah: <b>+${formatTokens(referral.reward)}</b> bonus token\nTotal bonus token: <b>${formatTokens(referral.referrerBonusTokens)}</b>\nTotal undangan: <b>${formatTokens(referral.referrerInvites)}</b>`
    : `\u{1F91D} Seorang user baru bergabung lewat link kamu (total ${formatTokens(referral.referrerInvites)}). Batas undangan berhadiah sudah tercapai, jadi tidak ada bonus token kali ini.`;
  await telegram('sendMessage', { chat_id: referral.referrerId, text, parse_mode: 'HTML' }).catch(() => {});
}

// --- Poll announcements ---------------------------------------------------
// Admin Panel -> Announcement -> Polling. A poll goes to every registered user as a message with
// one button per option (callback "poll_<pollId>_<optionIndex>"). Each user has one vote and
// can change it until the admin closes the poll; after voting they see the running result.
// Storage and vote rules live in usage-db.js; these limits mirror it (createPoll re-checks).
const POLL_MAX_QUESTION = 300;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
const POLL_MAX_OPTION_LENGTH = 60;

// Chrome of the user-facing poll message; the question and options are the admin's own words.
const POLL_TEXT = {
  id: {
    hint: 'Tap salah satu pilihan untuk memilih.',
    changeHint: 'Tap pilihan lain untuk mengubah suaramu.',
    yourVote: 'Pilihanmu',
    total: (count) => `Total: ${count.toLocaleString('id-ID')} suara`,
    closed: '\u{1F512} Polling ini sudah ditutup.',
    gone: 'Polling ini sudah tidak tersedia.',
  },
  en: {
    hint: 'Tap an option to vote.',
    changeHint: 'Tap another option to change your vote.',
    yourVote: 'Your vote',
    total: (count) => `Total: ${count.toLocaleString('en-US')} vote${count === 1 ? '' : 's'}`,
    closed: '\u{1F512} This poll is closed.',
    gone: 'This poll is no longer available.',
  },
};

// First line = question, every following line = one option.
function parsePollInput(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { question: lines[0] || '', options: lines.slice(1) };
}

// A readable reason the draft cannot be sent, or '' when it is fine.
function pollDraftProblem(draft) {
  if (!draft.question) return 'The first line must be the question.';
  if (draft.question.length > POLL_MAX_QUESTION) return `The question is too long (max ${POLL_MAX_QUESTION} characters, yours is ${draft.question.length}).`;
  if (draft.options.length < POLL_MIN_OPTIONS || draft.options.length > POLL_MAX_OPTIONS) {
    return `A poll needs ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options, one per line under the question (you sent ${draft.options.length}).`;
  }
  const tooLong = draft.options.find((option) => option.length > POLL_MAX_OPTION_LENGTH);
  if (tooLong) return `Each option can be at most ${POLL_MAX_OPTION_LENGTH} characters ("${tooLong.slice(0, 20)}..." has ${tooLong.length}).`;
  if (new Set(draft.options.map((option) => option.toLowerCase())).size !== draft.options.length) return 'Each option must be different.';
  return '';
}

// Two lines per option: its text, then "▰▰▰▱▱▱▱▱▱▱ 30% (3)".
function pollResultLines(poll) {
  return poll.options.flatMap((option, index) => {
    const count = poll.counts[index] || 0;
    const percent = poll.total ? Math.round((count / poll.total) * 100) : 0;
    return [escapeHtml(option), `${progressBar(percent)} ${percent}% (${count})`];
  });
}

// What a user sees. `poll.choice` (their vote) is only set on summaries made for them.
function pollUserMessage(poll, lang) {
  const t = POLL_TEXT[lang] || POLL_TEXT[DEFAULT_LANGUAGE];
  const closed = poll.status === 'closed';
  const voted = Number.isInteger(poll.choice);
  const lines = [`\u{1F4CA} <b>${escapeHtml(poll.question)}</b>`, ''];
  if (voted || closed) {
    lines.push(...pollResultLines(poll), '', t.total(poll.total));
    if (voted) lines.push(`\u{2705} ${t.yourVote}: <b>${escapeHtml(poll.options[poll.choice])}</b>`);
    lines.push('', closed ? t.closed : `<i>${t.changeHint}</i>`);
  } else {
    lines.push(`<i>${t.hint}</i>`);
  }
  return lines.join('\n');
}

// One button per option; a closed poll has none.
function pollUserKeyboard(poll) {
  if (poll.status === 'closed') return { inline_keyboard: [] };
  return { inline_keyboard: poll.options.map((option, index) => [{
    text: `${poll.choice === index ? '\u{2705} ' : ''}${option}`,
    callback_data: `poll_${poll.id}_${index}`,
  }]) };
}

// Sends the poll to every registered user (in their own language) in the background. The admin's
// message (`query.message`) shows the progress, then the poll results; how many got it is saved.
async function broadcastPoll(poll, query) {
  const recipients = await getAllUsers();
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const title = `\u{1F4CA} <b>Poll <code>#${poll.id}</code></b>`;
  return startBroadcast({
    label: `poll #${poll.id}`,
    recipients,
    send: (recipient) => telegram('sendMessage', {
      chat_id: recipient.telegramId,
      text: pollUserMessage(poll, userLanguage(recipient)),
      parse_mode: 'HTML',
      reply_markup: pollUserKeyboard(poll),
    }),
    report: async (stats) => {
      if (!stats.done) return editStatusMessage(chatId, messageId, broadcastStatusText(title, stats), { inline_keyboard: [] });
      await setPollSent(poll.id, stats.sent).catch((error) => console.error('[poll] could not save the sent count:', error.message));
      const latest = (await getPoll(poll.id).catch(() => null)) || poll;
      const skipped = [
        stats.unreachable && `${formatTokens(stats.unreachable)} unreachable`,
        stats.failed && `${formatTokens(stats.failed)} failed`,
      ].filter(Boolean).join(', ');
      const notice = `\u{2705} Poll <code>#${poll.id}</code> sent to ${formatTokens(stats.sent)} user(s)${skipped ? ` (${skipped})` : ''} in ${broadcastDuration(stats)}.`;
      return showAdminView(query, adminPollResultView(latest, notice));
    },
  });
}

// A user pressed an option button: record the vote and redraw their message in place.
async function handlePollVote(query, action) {
  const match = action.match(/^poll_(\d+)_(\d+)$/);
  if (!match) return null;
  try {
    const userId = String(query.from.id);
    const account = await getUser(userId);
    if (!account) return null; // only registered users receive polls, so only they vote
    const lang = userLanguage(account);
    const result = await votePoll(Number(match[1]), userId, Number(match[2]));
    const edit = result.poll
      ? { text: pollUserMessage(result.poll, lang), reply_markup: pollUserKeyboard(result.poll) }
      : { text: (POLL_TEXT[lang] || POLL_TEXT[DEFAULT_LANGUAGE]).gone, reply_markup: { inline_keyboard: [] } };
    return await telegram('editMessageText', {
      chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML', ...edit,
    });
  } catch (error) {
    // Tapping the option that is already chosen redraws an identical message, which Telegram refuses.
    if (!/message is not modified/i.test(error.message)) console.error('[poll] vote failed:', error.message);
    return null;
  }
}

function pollQuestionPreview(question, limit = 60) {
  return escapeHtml(question.length > limit ? `${question.slice(0, limit - 1)}\u{2026}` : question);
}

// First screen behind the admin panel's Announcement button: pick the kind of announcement.
function adminAnnounceView() {
  return {
    text: [
      '\u{1F4E2} <b>Announcement</b>',
      '',
      'Pilih jenis announcement yang mau dikirim ke semua user terdaftar:',
      '\u{1F4DD} <b>Announcement Biasa</b> \u{2014} pesan teks biasa.',
      '\u{1F4CA} <b>Polling</b> \u{2014} pertanyaan dengan pilihan jawaban; user memilih lewat tombol, hasilnya bisa kamu lihat.',
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '\u{1F4DD} Announcement Biasa', callback_data: 'admin_announce_text' }, { text: '\u{1F4CA} Polling', callback_data: 'admin_poll' }],
      [{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }],
    ] },
  };
}

async function adminPollsView(notice = '') {
  const polls = await listPolls(20);
  const open = polls.filter((poll) => poll.status === 'open');
  const closed = polls.filter((poll) => poll.status === 'closed').slice(0, 3);
  const line = (poll) => `<code>#${poll.id}</code> ${pollQuestionPreview(poll.question)}\n   ${poll.total} vote(s) \u{2022} sent to ${poll.sent} user(s)`;
  const lines = [
    ...(notice ? [notice, ''] : []),
    '\u{1F4CA} <b>Poll Announcements</b>',
    '',
    'Send a poll to every registered user. Each user gets one vote and can change it until you close the poll.',
    '',
    `\u{1F7E2} <b>Open (${open.length})</b>`,
    ...(open.length ? open.map(line) : ['None.']),
  ];
  if (closed.length) lines.push('', '\u{1F558} <b>Recently closed</b>', ...closed.map(line));
  const rows = [[{ text: '\u{2795} New Poll', callback_data: 'admin_poll_new' }]];
  const viewButtons = [...open, ...closed].map((poll) => ({
    text: `${poll.status === 'open' ? '\u{1F4CA}' : '\u{1F512}'} #${poll.id}`,
    callback_data: `admin_poll_view_${poll.id}`,
  }));
  for (let i = 0; i < viewButtons.length; i += 3) rows.push(viewButtons.slice(i, i + 3));
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_poll_list' }, { text: '\u{1F519} Back', callback_data: 'admin_announce_menu' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

function adminPollResultView(poll, notice = '') {
  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F4CA} <b>Poll #${poll.id}</b> \u{2014} ${poll.status === 'open' ? '\u{1F7E2} Open' : '\u{1F512} Closed'}`,
    '',
    `<b>${escapeHtml(poll.question)}</b>`,
    '',
    ...pollResultLines(poll),
    '',
    `Votes: <b>${poll.total}</b> \u{2022} sent to ${poll.sent} user(s)`,
    `Created: ${escapeHtml(wibTime(poll.createdAt))}`,
    ...(poll.closedAt ? [`Closed: ${escapeHtml(wibTime(poll.closedAt))}`] : []),
  ];
  const rows = [];
  if (poll.status === 'open') rows.push([{ text: '\u{1F6D1} Close poll', callback_data: `admin_poll_close_${poll.id}` }]);
  rows.push([{ text: '\u{1F504} Refresh', callback_data: `admin_poll_view_${poll.id}` }, { text: '\u{1F519} Polls', callback_data: 'admin_poll_list' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// Preview of a typed poll, before it goes out to everyone.
async function adminPollDraftView(draft, notice = '') {
  const recipients = (await getAllUsers()).length;
  const text = [
    ...(notice ? [notice, ''] : []),
    '\u{1F4CA} <b>New poll</b> \u{2014} preview',
    '',
    `<b>${escapeHtml(draft.question)}</b>`,
    ...draft.options.map((option) => `\u{2022} ${escapeHtml(option)}`),
    '',
    `It will be sent to <b>${recipients}</b> registered user(s). It cannot be edited once sent, but you can close it any time.`,
  ].join('\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: '\u{2705} Send to everyone', callback_data: 'admin_poll_go' }],
    [{ text: '\u{274C} Cancel', callback_data: 'admin_poll_cancel' }],
  ] } };
}

// Every admin_poll* button.
async function handlePollAction(query, action) {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  if (action === 'admin_poll') {
    // Opened from the admin panel: a new message, like the other admin screens.
    const view = await adminPollsView();
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action === 'admin_poll_list') return showAdminView(query, await adminPollsView());
  if (action === 'admin_poll_new') {
    pollDrafts.delete(userId);
    pendingAdminPoll.add(userId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: [
        '\u{1F4CA} Send the poll in <b>one message</b>:',
        `line 1 = the question, then one option per line (${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} options).`,
        '',
        'Example:',
        '<pre>Which model should we add next?\nClaude\nGemini\nGPT</pre>',
      ].join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{274C} Cancel', callback_data: 'admin_poll_list' }]] },
    });
  }
  if (action === 'admin_poll_cancel') {
    pollDrafts.delete(userId);
    return showAdminView(query, await adminPollsView('Poll cancelled.'));
  }
  if (action.startsWith('admin_poll_view_')) {
    const poll = await getPoll(Number(action.slice('admin_poll_view_'.length)));
    return showAdminView(query, poll ? adminPollResultView(poll) : await adminPollsView('\u{274C} Poll not found.'));
  }
  if (action.startsWith('admin_poll_close_')) {
    const closed = await closePoll(Number(action.slice('admin_poll_close_'.length)), userId);
    if (!closed) return showAdminView(query, await adminPollsView('\u{274C} That poll is already closed or no longer exists.'));
    return showAdminView(query, adminPollResultView(closed, `\u{1F512} Poll <code>#${closed.id}</code> closed. Voting has stopped.`));
  }
  if (action === 'admin_poll_go') {
    const draft = pollDrafts.get(userId);
    if (!draft) {
      return showAdminView(query, await adminPollsView('\u{26A0}\u{FE0F} Poll draft not found (the bot may have restarted). Start again with \u{2795} New Poll.'));
    }
    let poll;
    try {
      poll = await createPoll({ question: draft.question, options: draft.options, createdBy: userId });
    } catch (error) {
      return showAdminView(query, await adminPollDraftView(draft, `\u{274C} ${escapeHtml(error.message)}`));
    }
    pollDrafts.delete(userId);
    // Replace the preview first, so there is no second "Send" button to press while it goes out.
    await showAdminView(query, { text: `\u{23F3} Sending poll <code>#${poll.id}</code>...`, reply_markup: { inline_keyboard: [] } });
    // Runs in the background; the same message turns into the poll results when it is done.
    await broadcastPoll(poll, query);
    return null;
  }
  return showAdminView(query, await adminPollsView());
}

// --- Recent prompts --------------------------------------------------------
// Admin Panel -> Recent Prompts. server.js saves the latest user message of each API request in
// data/prompts.json, but only while this is ON (kept in settings, so it survives restarts).
// While OFF nothing is recorded and nothing stored is shown. Prompts and names are user input:
// they are always escaped before going into an HTML message.
// The numbers in the texts mirror usage-db.js (MAX_PROMPTS_PER_USER, MAX_PROMPT_CHARS).
const PROMPT_USERS_SHOWN = 15;
const PROMPT_PREVIEW_LENGTH = 60;
const PROMPT_BLOCK_LENGTHS = [600, 300, 120]; // tried in turn until a prompt still fits the message
const PROMPT_MESSAGE_BUDGET = 3800; // Telegram allows 4096 characters per message
const PROMPT_USER_ID = /^\d{1,20}$/;

// Cuts by characters (code points), so an emoji is never split into an invalid half.
function clipChars(text, max) {
  const chars = Array.from(String(text || ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}\u{2026}` : chars.join('');
}

function promptUserLabel(entry) {
  const name = entry.firstName || (entry.username ? `@${entry.username}` : `ID ${entry.telegramId}`);
  return entry.firstName && entry.username ? `${name} (@${entry.username})` : name;
}

async function adminPromptsView(notice = '') {
  const enabled = await isPromptLogEnabled();
  const users = await listPromptUsers();
  const stored = users.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F4AC} <b>Recent Prompts</b> \u{2014} ${enabled ? '\u{1F7E2} ON' : '\u{1F534} OFF'}`,
    '',
  ];
  if (!enabled) {
    lines.push(
      'While this is OFF, prompts are <b>not recorded</b> and stored ones are <b>not shown</b>.',
      stored
        ? `Stored from before: <b>${formatTokens(stored)}</b> prompt(s) from <b>${formatTokens(users.length)}</b> user(s), hidden until you turn this on or delete them.`
        : 'Nothing is stored.',
      '',
      'Turned ON, the proxy saves the latest user message of every API request: the last 10 per user, up to 1000 characters each. Prompts can contain private data; only the admin can see them here.',
    );
    const rows = [[{ text: '\u{1F7E2} Turn ON', callback_data: 'admin_prompts_on' }]];
    if (stored) rows.push([{ text: '\u{1F5D1}\u{FE0F} Delete stored prompts', callback_data: 'admin_prompts_clear' }]);
    rows.push([{ text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
  }
  lines.push(
    'Latest user message of every API request, last 10 per user. Tap a user to read their prompts.',
    '',
    `<b>Users (${formatTokens(users.length)})</b>`,
  );
  if (!users.length) lines.push('No prompts recorded yet.');
  const shown = [];
  let used = lines.join('\n').length;
  for (const entry of users.slice(0, PROMPT_USERS_SHOWN)) {
    const line = `${shown.length + 1}. <b>${escapeHtml(clipChars(promptUserLabel(entry), 40))}</b> \u{2022} ${formatTokens(entry.count)} \u{2022} ${escapeHtml(wibTime(entry.lastAt))}\n`
      + `   \u{21B3} <i>${escapeHtml(clipChars(String(entry.latestText || '').replace(/\s+/g, ' ').trim(), PROMPT_PREVIEW_LENGTH))}</i>`;
    if (used + line.length + 1 > PROMPT_MESSAGE_BUDGET) break;
    lines.push(line);
    shown.push(entry);
    used += line.length + 1;
  }
  if (users.length > shown.length) lines.push(`\u{2026} and ${formatTokens(users.length - shown.length)} more user(s) with older prompts.`);
  const userButtons = shown.map((entry, index) => ({ text: `${index + 1}. ${clipChars(promptUserLabel(entry), 24)}`, callback_data: `admin_prompts_u_${entry.telegramId}` }));
  const rows = [];
  for (let i = 0; i < userButtons.length; i += 2) rows.push(userButtons.slice(i, i + 2));
  rows.push([{ text: '\u{1F534} Turn OFF', callback_data: 'admin_prompts_off' }, ...(stored ? [{ text: '\u{1F5D1}\u{FE0F} Delete all', callback_data: 'admin_prompts_clear' }] : [])]);
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_prompts_list' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// One prompt: a meta line, then the (escaped) text in a collapsible quote. '' when even the
// shortest version would not fit in `budget` characters.
function promptBlock(prompt, budget) {
  const meta = [
    `\u{1F552} ${escapeHtml(wibTime(prompt.at))}`,
    prompt.model ? `<code>${escapeHtml(prompt.model)}</code>` : '',
    Number(prompt.repeats) > 1 ? `sent ${formatTokens(prompt.repeats)}\u{00D7} in a row` : '',
    Number(prompt.status) >= 400 ? `\u{274C} ${Number(prompt.status)}` : '',
    Number(prompt.chars) > PROMPT_BLOCK_LENGTHS[0] ? `${formatTokens(prompt.chars)} chars` : '',
  ].filter(Boolean).join(' \u{2022} ');
  for (const length of PROMPT_BLOCK_LENGTHS) {
    const block = `${meta}\n<blockquote expandable>${escapeHtml(clipChars(prompt.text, length))}</blockquote>`;
    if (block.length <= budget) return block;
  }
  return '';
}

async function adminUserPromptsView(telegramId) {
  if (!await isPromptLogEnabled()) return adminPromptsView('\u{1F534} Recent Prompts is OFF, so stored prompts are not shown.');
  const data = PROMPT_USER_ID.test(telegramId) ? await getUserPrompts(telegramId) : null;
  if (!data) return adminPromptsView('No stored prompts for that user.');
  const header = [
    `\u{1F4AC} <b>Prompts \u{2014} ${escapeHtml(clipChars(promptUserLabel(data), 60))}</b>`,
    `ID <code>${escapeHtml(data.telegramId)}</code> \u{2022} ${formatTokens(data.prompts.length)} prompt(s), newest first`,
  ].join('\n');
  const blocks = [];
  let used = header.length;
  for (const prompt of data.prompts) {
    const block = promptBlock(prompt, PROMPT_MESSAGE_BUDGET - used - 2);
    if (!block) break;
    blocks.push(block);
    used += block.length + 2;
  }
  const hidden = data.prompts.length - blocks.length;
  const text = [header, ...blocks, ...(hidden ? [`<i>\u{2026} ${hidden} older prompt(s) not shown (message size limit).</i>`] : [])].join('\n\n');
  return { text, reply_markup: { inline_keyboard: [
    [{ text: '\u{1F5D1}\u{FE0F} Delete this user\'s prompts', callback_data: `admin_prompts_del_${data.telegramId}` }],
    [{ text: '\u{1F504} Refresh', callback_data: `admin_prompts_u_${data.telegramId}` }, { text: '\u{1F519} All users', callback_data: 'admin_prompts_list' }],
  ] } };
}

function confirmView(text, yesData, noData) {
  return { text, reply_markup: { inline_keyboard: [[
    { text: '\u{2705} Yes, delete', callback_data: yesData },
    { text: '\u{274C} Cancel', callback_data: noData },
  ]] } };
}

// Every admin_prompts* button (admin-only: checked for every admin_ action before this runs).
async function handlePromptsAction(query, action) {
  const chatId = query.message.chat.id;
  if (action === 'admin_prompts') {
    // Opened from the admin panel: a new message, like the other admin screens.
    const view = await adminPromptsView();
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action === 'admin_prompts_list') return showAdminView(query, await adminPromptsView());
  if (action === 'admin_prompts_on' || action === 'admin_prompts_off') {
    const on = await setPromptLogEnabled(action === 'admin_prompts_on');
    return showAdminView(query, await adminPromptsView(on
      ? '\u{1F7E2} Recording is ON. New prompts will show up here.'
      : '\u{1F534} Recording is OFF. Nothing new is saved and stored prompts are hidden.'));
  }
  if (action === 'admin_prompts_clear') {
    const users = await listPromptUsers();
    const stored = users.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
    if (!stored) return showAdminView(query, await adminPromptsView('Nothing is stored.'));
    return showAdminView(query, confirmView(
      `\u{1F5D1}\u{FE0F} Delete <b>all ${formatTokens(stored)}</b> stored prompt(s) from <b>${formatTokens(users.length)}</b> user(s)? This cannot be undone.`,
      'admin_prompts_clear_yes', 'admin_prompts_list',
    ));
  }
  if (action === 'admin_prompts_clear_yes') {
    const removed = await clearAllPrompts();
    return showAdminView(query, await adminPromptsView(`\u{1F5D1}\u{FE0F} Deleted ${formatTokens(removed)} prompt(s).`));
  }
  if (action.startsWith('admin_prompts_u_')) return showAdminView(query, await adminUserPromptsView(action.slice('admin_prompts_u_'.length)));
  if (action.startsWith('admin_prompts_del_')) {
    const id = action.slice('admin_prompts_del_'.length);
    const data = PROMPT_USER_ID.test(id) ? await getUserPrompts(id) : null;
    if (!data) return showAdminView(query, await adminPromptsView('No stored prompts for that user.'));
    return showAdminView(query, confirmView(
      `\u{1F5D1}\u{FE0F} Delete all ${formatTokens(data.prompts.length)} stored prompt(s) of <b>${escapeHtml(clipChars(promptUserLabel(data), 60))}</b>? This cannot be undone.`,
      `admin_prompts_delok_${id}`, `admin_prompts_u_${id}`,
    ));
  }
  if (action.startsWith('admin_prompts_delok_')) {
    const id = action.slice('admin_prompts_delok_'.length);
    const removed = PROMPT_USER_ID.test(id) ? await clearPrompts(id) : 0;
    return showAdminView(query, await adminPromptsView(`\u{1F5D1}\u{FE0F} Deleted ${formatTokens(removed)} prompt(s) of user <code>${escapeHtml(id)}</code>.`));
  }
  return showAdminView(query, await adminPromptsView());
}

// --- AI moderation --------------------------------------------------------
// Admin Panel -> AI Moderation. server.js asks our upstream checker model (MODERATION_MODEL) about
// every request for a moderated family before forwarding it, rejects cyber abuse / ToS violations
// and saves them in data/moderation.json (moderation.js). Alerts per blocked prompt are sent by
// server.js with this bot's token; their buttons (admin_mod, admin_mod_n_<id>) land here.
// Prompt texts and names are user input: always escaped.
const MODERATION_ENTRIES_SHOWN = 10;
const MODERATION_ID = /^[a-f0-9]{8}$/;

function moderationUserLabel(entry) {
  const name = entry.firstName || (entry.username ? `@${entry.username}` : `ID ${entry.telegramId || '?'}`);
  return entry.firstName && entry.username ? `${name} (@${entry.username})` : name;
}

async function adminModerationView(notice = '') {
  const settings = await getModerationSettings();
  const log = await listModerationBlocks(MODERATION_ENTRIES_SHOWN);
  const stats = log.stats || {};
  const families = settings.families.join(', ') || '-';
  const lines = [
    ...(notice ? [notice, ''] : []),
    `\u{1F6E1}\u{FE0F} <b>AI Moderation</b> \u{2014} ${settings.enabled ? '\u{1F7E2} ON' : '\u{1F534} OFF'}`,
    `Checker: <code>${escapeHtml(settings.model)}</code>`,
    `Families: <b>${escapeHtml(families)}</b> \u{2022} Alerts: ${settings.notify ? '\u{1F514} ON' : '\u{1F515} OFF'}`,
    '',
    `<blockquote>Every ${escapeHtml(families)} request is checked by our AI before it is forwarded. Prompts flagged as cyber abuse or a ToS violation are rejected (HTTP 400) and not billed. If the checker fails or times out, the request goes through (fail-open) and the error is counted below.</blockquote>`,
    `\u{1F4CA} Since ${escapeHtml(wibTime(stats.since))}: checked <b>${formatTokens(stats.checked)}</b> \u{2022} blocked <b>${formatTokens(stats.blocked)}</b> \u{2022} checker errors <b>${formatTokens(stats.errors)}</b>`,
  ];
  if (stats.lastError) lines.push(`\u{26A0}\u{FE0F} Last error (${escapeHtml(wibTime(stats.lastErrorAt))}): <code>${escapeHtml(clipChars(stats.lastError, 160))}</code>`);
  lines.push('', `<b>Recently blocked (${formatTokens(log.total)})</b>`);
  if (!log.entries.length) lines.push('Nothing blocked yet.');
  log.entries.forEach((entry, index) => {
    lines.push(`${index + 1}. <b>${escapeHtml(clipChars(moderationUserLabel(entry), 32))}</b> \u{2022} ${escapeHtml(wibTime(entry.at))} \u{2022} <code>${escapeHtml(entry.model)}</code> \u{2022} ${escapeHtml(entry.category)}\n`
      + `   \u{21B3} <i>${escapeHtml(clipChars(String(entry.text || '').replace(/\s+/g, ' ').trim(), PROMPT_PREVIEW_LENGTH))}</i>`);
  });
  const entryButtons = log.entries.map((entry, index) => ({ text: `${index + 1}. ${clipChars(moderationUserLabel(entry), 22)}`, callback_data: `admin_mod_v_${entry.id}` }));
  const rows = [];
  for (let i = 0; i < entryButtons.length; i += 2) rows.push(entryButtons.slice(i, i + 2));
  rows.push([
    settings.enabled ? { text: '\u{1F534} Turn OFF', callback_data: 'admin_mod_off' } : { text: '\u{1F7E2} Turn ON', callback_data: 'admin_mod_on' },
    settings.notify ? { text: '\u{1F515} Alerts OFF', callback_data: 'admin_mod_alert_off' } : { text: '\u{1F514} Alerts ON', callback_data: 'admin_mod_alert_on' },
  ]);
  if (log.total || Number(stats.checked) || Number(stats.errors)) rows.push([{ text: '\u{1F5D1}\u{FE0F} Clear log & counters', callback_data: 'admin_mod_clear' }]);
  rows.push([{ text: '\u{1F504} Refresh', callback_data: 'admin_mod_list' }, { text: '\u{1F519} Back to admin panel', callback_data: 'admin_panel' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function adminModerationBlockView(id) {
  const entry = MODERATION_ID.test(id) ? await getModerationBlock(id) : null;
  if (!entry) return adminModerationView('That blocked prompt is no longer stored.');
  const lines = [
    `\u{1F6E1}\u{FE0F} <b>Blocked prompt</b> <code>#${escapeHtml(entry.id)}</code>`,
    `\u{1F464} ${escapeHtml(clipChars(moderationUserLabel(entry), 60))} \u{2022} ID <code>${escapeHtml(entry.telegramId)}</code>`,
    `\u{1F552} ${escapeHtml(wibTime(entry.at))} \u{2022} <code>${escapeHtml(entry.model)}</code> \u{2022} <code>${escapeHtml(entry.endpoint)}</code>`,
    `\u{1F3F7}\u{FE0F} Category: <b>${escapeHtml(entry.category)}</b>`,
    ...(entry.reason ? [`\u{1F4DD} ${escapeHtml(entry.reason)}`] : []),
    `<blockquote expandable>${escapeHtml(clipChars(entry.text, 2500))}</blockquote>`,
    ...(Number(entry.chars) > Array.from(String(entry.text || '')).length ? [`<i>${formatTokens(entry.chars)} characters in total; the start is stored.</i>`] : []),
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [
    [{ text: '\u{1F519} AI Moderation', callback_data: 'admin_mod_list' }],
  ] } };
}

// Every admin_mod* button (admin-only: checked for every admin_ action before this runs).
async function handleModerationAction(query, action) {
  const chatId = query.message.chat.id;
  const sendNew = (view) => telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  // From the admin panel or an alert: a new message, so the panel / alert stays as it was.
  if (action === 'admin_mod') return sendNew(await adminModerationView());
  if (action.startsWith('admin_mod_n_')) return sendNew(await adminModerationBlockView(action.slice('admin_mod_n_'.length)));
  if (action.startsWith('admin_mod_v_')) return showAdminView(query, await adminModerationBlockView(action.slice('admin_mod_v_'.length)));
  if (action === 'admin_mod_on' || action === 'admin_mod_off') {
    const settings = await setModerationSettings({ enabled: action === 'admin_mod_on' });
    return showAdminView(query, await adminModerationView(settings.enabled
      ? '\u{1F7E2} Moderation is ON. New requests are checked before they are forwarded.'
      : '\u{1F534} Moderation is OFF. Requests are forwarded without a check.'));
  }
  if (action === 'admin_mod_alert_on' || action === 'admin_mod_alert_off') {
    const settings = await setModerationSettings({ notify: action === 'admin_mod_alert_on' });
    return showAdminView(query, await adminModerationView(settings.notify
      ? '\u{1F514} You will get a message for every blocked prompt.'
      : '\u{1F515} Alerts are off. Blocked prompts are still saved here.'));
  }
  if (action === 'admin_mod_clear') {
    return showAdminView(query, confirmView(
      '\u{1F5D1}\u{FE0F} Delete every stored blocked prompt and reset the moderation counters? This cannot be undone.',
      'admin_mod_clear_yes', 'admin_mod_list',
    ));
  }
  if (action === 'admin_mod_clear_yes') {
    const removed = await clearModerationBlocks();
    return showAdminView(query, await adminModerationView(`\u{1F5D1}\u{FE0F} Deleted ${formatTokens(removed)} blocked prompt(s) and reset the counters.`));
  }
  return showAdminView(query, await adminModerationView());
}

// Toggle screens edit the same message instead of posting a new one per tap.
async function showAdminView(query, view) {
  try {
    return await telegram('editMessageText', {
      chat_id: query.message.chat.id, message_id: query.message.message_id, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup,
    });
  } catch (error) {
    if (/message is not modified/i.test(error.message)) return null;
    return telegram('sendMessage', { chat_id: query.message.chat.id, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
}

async function handleCallbackQuery(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const action = query.data;
  // Slash commands that mirror a menu button (see COMMAND_ACTIONS) run through this handler
  // with a made-up query that has no id, so there is nothing to answer.
  if (query.id) await telegram('answerCallbackQuery', { callback_query_id: query.id });
  if (action === 'lang_en' || action === 'lang_id') return handleLanguageChoice(query, action.slice(5));
  // Poll votes come from every user and must not abandon an admin's half-finished prompt.
  if (action.startsWith('poll_')) return handlePollVote(query, action);
  // Any button press abandons a half-finished text prompt; the actions below
  // that need a text reply set their own pending state again.
  clearPendingInput(userId);
  if (action.startsWith('admin_') && !isAdmin(userId)) {
    return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
  }
  if (action === 'admin_groups' || action === 'admin_group_prepare' || action.startsWith('admin_group_send_')) {
    return handleAdminGroupAction(query, action);
  }

  if (action === 'ticket') return startUserTicket(chatId, userId);
  if (action === 'admin_models' || action === 'admin_models_sync') {
    try {
      if (action === 'admin_models_sync') await syncSupportedModels();
      const view = await adminModelFamiliesView();
      if (action === 'admin_models_sync') view.text = `\u{2705} Model list resynced from upstream.\n\n${view.text}`;
      return action === 'admin_models' ? telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup }) : showAdminView(query, view);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not load models: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action.startsWith('admin_mdl_fam_')) {
    const familyIndex = Number(action.slice('admin_mdl_fam_'.length));
    if (!MODEL_FAMILIES[familyIndex]) return telegram('sendMessage', { chat_id: chatId, text: 'Unknown family.', reply_markup: adminBackKeyboard() });
    return showAdminView(query, await adminFamilyModelsView(familyIndex));
  }
  if (action.startsWith('admin_mdl_ft_')) {
    // Family toggle, from the families list or (suffix "_in") from inside the family.
    const [indexText, where] = action.slice('admin_mdl_ft_'.length).split('_');
    const family = MODEL_FAMILIES[Number(indexText)];
    if (!family) return telegram('sendMessage', { chat_id: chatId, text: 'Unknown family.', reply_markup: adminBackKeyboard() });
    const disabled = await getDisabledModels();
    await setFamilyDisabled(family, !disabled.families.includes(family));
    return showAdminView(query, where === 'in' ? await adminFamilyModelsView(Number(indexText)) : await adminModelFamiliesView());
  }
  if (action.startsWith('admin_mdl_mt_')) {
    const [familyText, modelText] = action.slice('admin_mdl_mt_'.length).split('_');
    await ensureModelCache();
    const model = familyModels(Number(familyText))[Number(modelText)];
    if (!model) return showAdminView(query, await adminModelFamiliesView());
    const disabled = await getDisabledModels();
    if (disabled.families.includes(MODEL_FAMILIES[Number(familyText)])) {
      // The family view already explains that the whole family is disabled.
      return showAdminView(query, await adminFamilyModelsView(Number(familyText)));
    }
    await setModelDisabled(model, !disabled.models.includes(model.toLowerCase()));
    return showAdminView(query, await adminFamilyModelsView(Number(familyText)));
  }
  if (action === 'admin_rl') {
    try {
      const view = await adminRateLimitFamiliesView();
      return query.message.text?.includes('Rate Limit') ? showAdminView(query, view)
        : telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not load models: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action.startsWith('admin_rl_')) {
    // admin_rl_<op>_<familyIndex>[_<modelIndex>]
    const [op, familyText, modelText] = action.slice('admin_rl_'.length).split('_');
    const familyIndex = Number(familyText);
    const modelIndex = modelText === undefined ? undefined : Number(modelText);
    if (!MODEL_FAMILIES[familyIndex]) return telegram('sendMessage', { chat_id: chatId, text: 'Unknown family.', reply_markup: adminBackKeyboard() });
    try {
      await ensureModelCache();
      if (op === 'fam') return showAdminView(query, await adminRateLimitFamilyView(familyIndex));
      if (op === 'fs') return promptRateLimit(chatId, userId, familyIndex);
      if (op === 'ms') {
        if (!familyModels(familyIndex)[modelIndex]) return showAdminView(query, await adminRateLimitFamilyView(familyIndex));
        return promptRateLimit(chatId, userId, familyIndex, modelIndex);
      }
      if (op === 'fc' || op === 'mc') {
        await applyRateLimit(familyIndex, op === 'mc' ? modelIndex : undefined, 0);
        const view = await adminRateLimitFamilyView(familyIndex);
        view.text = `\u{2705} Limit dihapus.\n\n${view.text}`;
        return showAdminView(query, view);
      }
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return telegram('sendMessage', { chat_id: chatId, text: 'Unknown action.', reply_markup: adminBackKeyboard() });
  }
  if (action === 'admin_app') {
    // Shown only while the Mini App button cannot open the app (see adminMiniAppButton).
    return telegram('sendMessage', { chat_id: chatId, text: adminMiniAppSetupMessage(), parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
  }
  if (action === 'admin_prompts' || action.startsWith('admin_prompts_')) {
    try {
      return await handlePromptsAction(query, action);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Recent Prompts: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_mod' || action.startsWith('admin_mod_')) {
    try {
      return await handleModerationAction(query, action);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} AI Moderation: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_poll' || action.startsWith('admin_poll_')) {
    try {
      return await handlePollAction(query, action);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Poll: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_bsn' || action.startsWith('admin_bsn_')) {
    try {
      return await handleBansosAction(query, action);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} BANSOS: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_mac' || action.startsWith('admin_mac_')) {
    try {
      return await handleAccessCodeAction(query, action);
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Kode Akses Model: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_cr' || action.startsWith('admin_cr_')) {
    try {
      return await handleAdminCreditAction(query, action);
    } catch (error) {
      console.error('[credits] admin view failed:', error.message);
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Kredit & Paket: ${escapeHtml(error.message)}\n\n${CREDIT_UNAVAILABLE}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'ticket_close') {
    const open = await getOpenTicketForUser(userId);
    const closed = open ? await closeTicket(open.id, 'user') : null;
    if (!closed) return telegram('sendMessage', { chat_id: chatId, text: 'Kamu tidak punya ticket yang terbuka.', reply_markup: menuKeyboard(userId) });
    return telegram('sendMessage', { chat_id: chatId, text: `\u{2705} Ticket #${closed.id} ditutup. Terima kasih! Kalau butuh bantuan lagi, buat ticket baru kapan saja. \u{1F64F}`, reply_markup: menuKeyboard(userId) });
  }
  if (action === 'admin_tickets') {
    const tickets = await listTickets();
    return telegram('sendMessage', { chat_id: chatId, text: adminTicketListMessage(tickets), parse_mode: 'HTML', reply_markup: adminTicketListKeyboard(tickets) });
  }
  if (action.startsWith('admin_ticket_view_')) {
    const ticket = await getTicket(action.slice('admin_ticket_view_'.length));
    if (!ticket) return telegram('sendMessage', { chat_id: chatId, text: 'Ticket not found.', reply_markup: adminTicketListKeyboard(await listTickets()) });
    return sendAdminTicketView(chatId, ticket);
  }
  if (action.startsWith('admin_ticket_reply_')) {
    const ticket = await getTicket(action.slice('admin_ticket_reply_'.length));
    if (!ticket || ticket.status !== 'open') return telegram('sendMessage', { chat_id: chatId, text: 'This ticket is closed or missing.', reply_markup: adminTicketListKeyboard(await listTickets()) });
    pendingAdminTicketReply.set(String(userId), ticket.id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{1F4AC} Chatting in <b>Ticket #${ticket.id}</b> with ${ticketUserLabel(ticket)}.\n\nEvery message you send now goes to this user (text, photos and files work). Press Exit chat when you are done.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F6AA} Exit chat', callback_data: 'admin_ticket_exit' }]] },
    });
  }
  if (action.startsWith('admin_ticket_close_')) {
    const closed = await closeTicket(action.slice('admin_ticket_close_'.length), 'admin');
    if (!closed) return telegram('sendMessage', { chat_id: chatId, text: 'Ticket already closed or not found.', reply_markup: adminTicketListKeyboard(await listTickets()) });
    await telegram('sendMessage', {
      chat_id: closed.userId,
      text: `\u{2705} Ticket #${closed.id} sudah ditutup oleh admin. Terima kasih! Kalau butuh bantuan lagi, buat ticket baru kapan saja. \u{1F64F}`,
      reply_markup: menuKeyboard(closed.userId),
    }).catch(() => {});
    const tickets = await listTickets();
    return telegram('sendMessage', { chat_id: chatId, text: `\u{1F512} Ticket #${closed.id} closed and the user was notified.\n\n${adminTicketListMessage(tickets)}`, parse_mode: 'HTML', reply_markup: adminTicketListKeyboard(tickets) });
  }
  if (action === 'admin_ticket_exit') {
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F6AA} Exited the ticket chat. Your messages are no longer sent to users.', reply_markup: await adminKeyboard() });
  }

  if (action === 'admin_users') {
    return telegram('sendMessage', { chat_id: chatId, text: await adminTopUsersMessage(), parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
  }
  if (action === 'admin_redeem') {
    const s = await getAdminStats();
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{1F39F}\u{FE0F} <b>Redeem Codes</b>\n\nCreated: <b>${formatTokens(s.redeemCodes)}</b> • Active: <b>${formatTokens(s.activeRedeemCodes)}</b>\nRedeemed: <b>${formatTokens(s.redemptions)}x</b> • Total: <b>${rupiah(s.redeemedAmount)}</b>`,
      parse_mode: 'HTML',
      reply_markup: adminRedeemKeyboard(),
    });
  }
  if (action === 'admin_redeem_create') {
    pendingAdminRedeem.set(String(userId), { step: 'amount' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '\u{1F39F}\u{FE0F} <b>Create Redeem Code</b>\n\nType the nominal (balance) for this code, e.g. <code>25000</code> or <code>Rp25.000</code>.\nOr pick a quick amount below:',
      parse_mode: 'HTML',
      reply_markup: adminRedeemAmountKeyboard(),
    });
  }
  if (action.startsWith('admin_redeem_amt_')) {
    const amount = parseNominal(action.slice('admin_redeem_amt_'.length));
    if (!amount) return telegram('sendMessage', { chat_id: chatId, text: 'Invalid nominal.', reply_markup: adminRedeemKeyboard() });
    return askRedeemUses(chatId, amount);
  }
  if (action.startsWith('admin_redeem_uses_custom_')) {
    const amount = parseNominal(action.slice('admin_redeem_uses_custom_'.length));
    if (!amount) return telegram('sendMessage', { chat_id: chatId, text: 'Invalid nominal.', reply_markup: adminRedeemKeyboard() });
    pendingAdminRedeem.set(String(userId), { step: 'uses', amount });
    return telegram('sendMessage', { chat_id: chatId, text: `\u{270F}\u{FE0F} Type how many users can redeem this ${rupiah(amount)} code (1-${formatTokens(MAX_REDEEM_USES)}).` });
  }
  if (action.startsWith('admin_redeem_make_')) {
    const [amountText, usesText] = action.slice('admin_redeem_make_'.length).split('_');
    return finishAdminRedeemCreate(chatId, userId, Number(amountText), Number(usesText));
  }
  if (action === 'admin_redeem_list') {
    const codes = await listRedeemCodes(15);
    return telegram('sendMessage', { chat_id: chatId, text: adminRedeemListMessage(codes), parse_mode: 'HTML', reply_markup: adminRedeemListKeyboard(codes) });
  }
  if (action.startsWith('admin_redeem_off_')) {
    const disabled = await disableRedeemCode(action.slice('admin_redeem_off_'.length));
    const codes = await listRedeemCodes(15);
    const notice = disabled ? `\u{1F6AB} Code <code>${escapeHtml(disabled.code)}</code> disabled.` : '\u{274C} Code not found.';
    return telegram('sendMessage', { chat_id: chatId, text: `${notice}\n\n${adminRedeemListMessage(codes)}`, parse_mode: 'HTML', reply_markup: adminRedeemListKeyboard(codes) });
  }
  if (action === 'redeem') {
    pendingUserRedeem.add(String(userId));
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '\u{1F39F}\u{FE0F} <b>Redeem Code</b>\n\nSend your redeem code now (example: <code>RDM-A1B2C3-D4E5F6</code>).\nThe nominal is added to your balance instantly.\n\n\u{1F510} Model access codes (<code>MDL-...</code>) are redeemed here too: they unlock a set of models for a limited period.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{274C} Cancel', callback_data: 'menu' }]] },
    });
  }

  if (action === 'dashboard') return sendDashboard(chatId, userId);
  if (action === 'menu') return telegram('sendMessage', { chat_id: chatId, text: await welcomeMessage(query.from.first_name, userId), parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
  if (action === 'referral') {
    const view = await referralView(query.from);
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup, disable_web_page_preview: true });
  }
  if (action === 'admin_panel') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    return telegram('sendMessage', { chat_id: chatId, text: await adminPanelMessage(), parse_mode: 'HTML', reply_markup: await adminKeyboard() });
  }
  if (action === 'admin_ref') return showAdminView(query, await adminReferralView());
  if (action === 'admin_ref_toggle') {
    const current = await getReferralSettings();
    const updated = await setReferralSettings({ enabled: !current.enabled });
    return showAdminView(query, await adminReferralView(updated.enabled ? '\u{2705} Referral enabled.' : '\u{2705} Referral disabled. New invites earn nothing until it is enabled again.'));
  }
  if (action === 'admin_ref_reward' || action === 'admin_ref_cap') {
    const current = await getReferralSettings();
    pendingAdminReferral.set(String(userId), action === 'admin_ref_reward' ? 'reward' : 'cap');
    return showAdminView(query, action === 'admin_ref_reward' ? adminReferralRewardView(current.rewardTokens) : adminReferralCapView(current.maxRewardsPerUser));
  }
  if (action.startsWith('admin_ref_rw_') || action.startsWith('admin_ref_cp_')) {
    const isReward = action.startsWith('admin_ref_rw_');
    const value = Number(action.slice('admin_ref_rw_'.length));
    const valid = Number.isSafeInteger(value) && (isReward ? value > 0 && value <= MAX_REFERRAL_REWARD : value >= 0 && value <= MAX_REFERRAL_CAP);
    if (!valid) return showAdminView(query, await adminReferralView('\u{274C} Invalid value.'));
    const updated = await setReferralSettings(isReward ? { rewardTokens: value } : { maxRewardsPerUser: value });
    const notice = isReward
      ? `\u{2705} Reward set to <b>${formatTokens(updated.rewardTokens)}</b> tokens.`
      : `\u{2705} Max rewarded invites per user: <b>${updated.maxRewardsPerUser ? formatTokens(updated.maxRewardsPerUser) : 'unlimited'}</b>.`;
    return showAdminView(query, await adminReferralView(notice));
  }
  if (action === 'admin_reset_stats') {
    // Two-step: this only shows what will be wiped; the reset runs on the confirm button.
    return showAdminView(query, {
      text: [
        '\u{267B}\u{FE0F} <b>Reset Stats</b>',
        '',
        'This sets the dashboard statistics back to <b>0</b>:',
        '• Requests, success/error counts, tokens and usage billed (all users)',
        '• Every user\'s request logs and usage summaries, and the admin request logs',
        '',
        '<b>Not</b> touched: users, API keys, balances, bonus tokens, referrals, top-up orders, redeem codes, tickets, settings.',
        '',
        'A backup of the database is saved before resetting. Continue?',
      ].join('\n'),
      reply_markup: { inline_keyboard: [
        [{ text: '\u{2705} Yes, reset to 0', callback_data: 'admin_reset_stats_yes' }],
        [{ text: '\u{274C} Cancel', callback_data: 'admin_panel' }],
      ] },
    });
  }
  if (action === 'admin_reset_stats_yes') {
    try {
      const result = await resetStats(userId);
      const notice = `\u{2705} Stats reset to 0 for <b>${formatTokens(result.users)}</b> users.\nBackup: <code>${escapeHtml(result.backup)}</code>`;
      return showAdminView(query, { text: `${notice}\n\n${await adminPanelMessage()}`, reply_markup: await adminKeyboard() });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Reset failed: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
  }
  if (action === 'admin_free_toggle') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const enabled = !await isAllModelsFree();
    await setAllModelsFree(enabled);
    return telegram('sendMessage', { chat_id: chatId, text: `${enabled ? '\u{2705} All models are now free.' : '\u{2705} Normal model pricing restored.'}\n\n${await adminPanelMessage()}`, parse_mode: 'HTML', reply_markup: await adminKeyboard() });
  }
  if (action === 'admin_payments_toggle') {
    if (!isAdmin(userId)) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const enabled = !await isPaymentsEnabled();
    await setPaymentsEnabled(enabled);
    const notice = enabled
      ? '\u{2705} Payments are now <b>OPEN</b>. Users can top up again.'
      : '\u{1F512} Payments are now <b>CLOSED</b>. Users cannot create new top ups.';
    return telegram('sendMessage', { chat_id: chatId, text: `${notice}\n\n${await adminPanelMessage()}`, parse_mode: 'HTML', reply_markup: await adminKeyboard() });
  }
  if (action === 'admin_topup') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    // Opened from the admin panel: a fresh list (first page, no search) in a new message.
    adminUserListState.set(String(userId), { page: 0, query: '' });
    const view = await adminUserListView(userId);
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action.startsWith('admin_ul_p_') || action === 'admin_ul_clear' || action === 'admin_ul_back') {
    const state = userListState(userId);
    if (action === 'admin_ul_clear') adminUserListState.set(String(userId), { page: 0, query: '' });
    if (action.startsWith('admin_ul_p_')) {
      adminUserListState.set(String(userId), { ...state, page: Math.max(0, Number(action.slice('admin_ul_p_'.length)) || 0) });
    }
    return showAdminView(query, await adminUserListView(userId));
  }
  if (action === 'admin_ul_search') {
    pendingAdminUserSearch.add(String(userId));
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '\u{1F50D} Kirim <b>ID Telegram</b>, <b>@username</b>, atau sebagian <b>nama</b> user yang dicari.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Batal', callback_data: 'admin_ul_back' }]] },
    });
  }
  if (action.startsWith('admin_uu_')) {
    const [targetId, daysText] = action.slice('admin_uu_'.length).split('_');
    const days = USAGE_PERIODS.includes(Number(daysText)) ? Number(daysText) : 7;
    const view = await adminUserUsageView(targetId, days);
    return showAdminView(query, view || await adminUserListView(userId, '\u{274C} User tidak ditemukan.'));
  }
  if (action === 'admin_logs') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const logs = await getAdminLogs(30);
    const lines = logs.map((entry) => {
      const model = entry.model ? ` model=${stripModelPrefix(entry.model)}` : '';
      const user = entry.userId ? ` user=${entry.userId}` : ' anonymous';
      const tokens = ` in=${Number(entry.inputTokens || 0)} out=${Number(entry.outputTokens || 0)} total=${Number(entry.totalTokens || 0)}${entry.estimated ? ' (estimated)' : ''}`;
      const cost = ` cost=Rp${Number(entry.cost || 0).toLocaleString('id-ID', { maximumFractionDigits: 4 })}`;
      const balance = entry.balanceAfter === undefined ? '' : ` balance=Rp${Number(entry.balanceAfter || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;
      const rate = entry.pricePerMillion ? ` rate=Rp${Number(entry.pricePerMillion).toLocaleString('id-ID')}/1M` : '';
      const credit = entry.credits !== undefined ? ` credits=${Number(entry.credits || 0)} x${entry.multiplier || '?'}` : '';
      const funding = entry.funding && entry.funding !== 'credits' ? ` paid=${entry.funding}` : '';
      return `${wibLogTime(entry.at)} ${entry.method} ${entry.path} → ${entry.status}${model}${user}${tokens}${rate}${cost}${credit}${funding}${balance}`;
    });
    const logText = lines.join('\n').slice(-3500);
    const text = lines.length
      ? `\u{1F4DC} <b>Admin Request Logs</b>\n<i>Times in WIB (GMT+7)</i>\n\n<code>${escapeHtml(logText)}</code>`
      : '\u{1F4DC} <b>Admin Request Logs</b>\n\nNo requests recorded yet.';
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: await adminKeyboard() });
  }
  if (action.startsWith('admin_topup_user_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const view = await adminUserDetailView(action.slice('admin_topup_user_'.length));
    return showAdminView(query, view || await adminUserListView(userId, '\u{274C} User tidak ditemukan.'));
  }
  if (action.startsWith('admin_topup_amount_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const parts = action.split('_');
    const targetId = parts[3];
    const amount = Number(parts[4]);
    const newBalance = await adjustBalance(targetId, amount);
    if (newBalance === null) return showAdminView(query, await adminUserListView(userId, '\u{274C} Top up gagal: user atau nominal tidak valid.'));
    await telegram('sendMessage', { chat_id: targetId, text: `\u{1F389} <b>Balance added!</b>\n\nTop up: <b>Rp${amount.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML' }).catch(() => {});
    const view = await adminUserDetailView(targetId, `\u{2705} Saldo ditambah <b>${rupiah(amount)}</b>. Saldo baru: <b>${rupiah(newBalance)}</b>.`);
    return showAdminView(query, view || await adminUserListView(userId));
  }
  if (action.startsWith('admin_topup_custom_')) {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    const targetId = action.slice('admin_topup_custom_'.length);
    const target = USER_ID_PATTERN.test(targetId) ? await getUser(targetId) : null;
    if (!target) return showAdminView(query, await adminUserListView(userId, '\u{274C} User tidak ditemukan.'));
    pendingAdminTopups.set(String(userId), targetId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `\u{270F}\u{FE0F} Send custom balance adjustment for <b>${escapeHtml(userDisplayName(target))}</b> (now ${rupiah(target.balance)}).\n\nExamples:\n<code>+50000</code> add Rp50.000\n<code>-10000</code> take Rp10.000`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{1F519} Cancel', callback_data: `admin_topup_user_${targetId}` }]] },
    });
  }
  if (action === 'admin_announce') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    // One Announcement button, two kinds: a plain text broadcast or a poll.
    const view = adminAnnounceView();
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action === 'admin_announce_menu') return showAdminView(query, adminAnnounceView());
  if (action === 'admin_announce_text') {
    if (String(userId) !== ADMIN_TELEGRAM_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Access denied.' });
    pendingAdminActions.add(String(userId));
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4E2} Send the announcement text now. It will be delivered to every registered user.' });
  }
  if (action === 'create_key') {
    const key = await createApiKey(userId, { firstName: query.from.first_name, username: query.from.username });
    return sendDashboard(chatId, userId, `\u{1F389} <b>New API key created!</b>\n\n<code>${key}</code>\n\nKeep this key private.`);
  }

  if (action === 'revoke') {
    const user = await getUser(userId);
    const activeKeys = (user?.apiKeys || []).filter((entry) => entry.active !== false);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: activeKeys.length ? '\u{1F5D1}\u{FE0F} <b>Revoke API Key</b>\n\nChoose the key you want to revoke. This cannot be undone.' : 'No active API keys to revoke.',
      parse_mode: 'HTML',
      reply_markup: revokeKeyboard(user),
    });
  }
  if (action.startsWith('revoke_')) {
    const revokedKey = await revokeApiKey(userId, action.slice('revoke_'.length));
    if (!revokedKey) return telegram('sendMessage', { chat_id: chatId, text: '\u{274C} API key not found or already revoked.', reply_markup: dashboardKeyboard() });
    return sendDashboard(chatId, userId, '\u{2705} API key revoked successfully. It can no longer access the API.');
  }
  if (action === 'model_price') {
    try {
      const text = await modelPriceMessage(userId);
      return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Could not load model prices: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    }
  }
  if (action === 'model_resync') {
    try {
      const text = await modelPriceMessage(userId);
      return telegram('sendMessage', { chat_id: chatId, text: `\u{2705} Models resynced from upstream.\n\n${text}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      return telegram('sendMessage', { chat_id: chatId, text: `\u{274C} Model resync failed: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    }
  }

  if (action === 'credits' || action === 'cr_models' || action === 'cr_hist' || action === 'cr_ul') {
    const builders = { credits: creditMainView, cr_models: creditModelsView, cr_hist: creditHistoryView, cr_ul: creditUnlimitedView };
    try {
      const view = await builders[action](String(userId));
      // Opened from a credit screen: replace it; from elsewhere (menu, /kredit): a new message.
      const onCreditScreen = /KREDIT TOKEN|MODEL & MULTIPLIER|RIWAYAT KREDIT|UNLIMITED/.test(query.message?.text || '');
      return onCreditScreen && query.id ? showAdminView(query, view) : telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      console.error('[credits] view failed:', error.message);
      return telegram('sendMessage', { chat_id: chatId, text: CREDIT_UNAVAILABLE, reply_markup: menuKeyboard(userId) });
    }
  }

  const paymentAction = action === 'top_up' || action === 'top_up_rp' || action.startsWith('topup_') || action.startsWith('crbuy_') || action.startsWith('ulbuy_');
  if (paymentAction && !await isPaymentsEnabled()) {
    const text = PAYMENTS_OFF_MESSAGE + (isAdmin(userId) ? PAYMENTS_OFF_ADMIN_HINT : '');
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
  }
  if (action === 'top_up') {
    // Token credit packages first; the old Rupiah top-up stays available behind its own button.
    try {
      const view = await creditBuyView();
      return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      console.error('[credits] buy view failed, showing the Rupiah top-up:', error.message);
    }
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4B3} <b>Top up balance</b>\n\nChoose an amount to pay securely with Cashi.id:', parse_mode: 'HTML', reply_markup: topUpKeyboard() });
  }
  if (action === 'top_up_rp') {
    return telegram('sendMessage', { chat_id: chatId, text: '\u{1F4B5} <b>Top up saldo Rupiah (lama)</b>\n\nSaldo Rupiah terpisah dari kredit token dan dipakai dengan harga per 1M token lama.\nChoose an amount to pay securely with Cashi.id:', parse_mode: 'HTML', reply_markup: topUpKeyboard() });
  }
  if (action.startsWith('crbuy_')) {
    return startCreditPurchase(chatId, String(userId), { kind: 'credits', packageId: action.slice('crbuy_'.length) });
  }
  if (action.startsWith('ulbuy_')) {
    return startCreditPurchase(chatId, String(userId), { kind: 'unlimited', hours: Number(action.slice('ulbuy_'.length)) });
  }
  if (action.startsWith('topup_')) {
    const amount = Number(action.replace('topup_', ''));
    return createCashiOrder(chatId, userId, amount);
  }
  if (action.startsWith('status_')) {
    return refreshCashiStatus(chatId, userId, action.slice('status_'.length));
  }

  if (action === 'logs') {
    const user = await getUser(userId);
    const logs = user?.logs || [];
    const lines = logs.slice(-10).reverse().map((entry, index) => {
      const input = Number(entry.inputTokens || 0);
      const output = Number(entry.outputTokens || 0);
      const total = input + output;
      let billing;
      if (entry.funding === 'credits') {
        const rate = entry.rateModel && entry.rateModel !== stripModelPrefix(entry.model) ? ` tarif ${escapeHtml(entry.rateModel)}` : '';
        billing = `💎 Kredit: <b>${formatTokens(entry.credits)}</b> (${multiplierText(entry.multiplier || '?')}${rate})${entry.shortfall ? ' ⚠️ saldo tidak cukup' : ''}${entry.partial ? ' <i>(stream terputus)</i>' : ''}`;
      } else if (entry.funding === 'unlimited') {
        billing = '♾️ Paket unlimited <i>(kredit tidak dipotong)</i>';
      } else {
        billing = `💰 Tarif: <b>Rp${formatTokens(entry.pricePerMillion)}/1M</b>\n💳 Biaya: <b>${formatCost(entry.cost)}</b>`;
      }
      return [
        `<b>#${index + 1} ${entry.status >= 400 ? '❌' : '✅'} ${escapeHtml(entry.endpoint)}</b>`,
        `🕒 ${escapeHtml(entry.at)}`,
        `🤖 Model: <code>${escapeHtml(stripModelPrefix(entry.model) || 'unknown')}</code>`,
        `📥 Input: <b>${formatTokens(input)}</b>${entry.cachedInputTokens ? ` (cache ${formatTokens(entry.cachedInputTokens)})` : ''}  •  📤 Output: <b>${formatTokens(output)}</b>`,
        `🔢 Total: <b>${formatTokens(total)}</b>${entry.estimated ? ' <i>(estimasi)</i>' : ''}`,
        billing,
      ].join('\n');
    });
    const estimatedNote = logs.slice(-10).some((entry) => entry.estimated)
      ? '\n\n<i>(estimasi) = upstream tidak mengirim jumlah token, jadi token dihitung dari panjang teks.</i>'
      : '';
    const text = lines.length ? `\u{1F9FE} <b>Recent API Logs</b>\n\n${lines.join('\n\n')}${estimatedNote}` : '\u{1F9FE} <b>Recent API Logs</b>\n\nNo API usage yet. \u{1F4ED}';
    return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: dashboardKeyboard() });
  }
  if (action === 'usage') {
    // From the dashboard button or /usage: a new message, last 7 days.
    const view = await userUsageView(userId, 7);
    return telegram('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
  }
  if (action.startsWith('usage_')) {
    const days = Number(action.slice('usage_'.length));
    return showAdminView(query, await userUsageView(userId, USAGE_PERIODS.includes(days) ? days : 7));
  }

  return telegram('sendMessage', { chat_id: chatId, text: 'Choose an option from the menu.', parse_mode: 'HTML', reply_markup: menuKeyboard(userId) });
}

async function handleMessage(message) {
  const user = message.from || {};
  const userId = String(user.id || message.chat.id);
  // Retries the /admin menu entry if the admin's chat was not known to Telegram at startup.
  if (isAdmin(userId)) ensureAdminCommands();
  if (!message.text) {
    // Photos, files, voice notes etc. are only used inside ticket chats.
    if (ticketMediaType(message)) {
      await ensureUser(user.id || message.chat.id, { firstName: user.first_name, username: user.username });
      await routeTicketMessage(message, userId, user);
    }
    return;
  }
  const profile = { firstName: user.first_name, username: user.username };
  // "/start <code>" from a t.me/<bot>?start=<code> referral link. The account is
  // created and the referral checked in one step, so "is this a new user?" is
  // answered before anything else could create the account.
  const startCommand = message.text.trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  let account;
  let referral = null;
  if (startCommand?.[1]) {
    const started = await startWithReferral(user.id || message.chat.id, profile, startCommand[1]);
    account = started.user;
    referral = started.referral;
  } else {
    account = await ensureUser(user.id || message.chat.id, profile);
  }
  const text = message.text.trim();
  if (text.startsWith('/') && ['rate', 'rate_search'].includes(pendingAdminCredit.get(userId)?.mode)) {
    pendingAdminCredit.delete(userId);
  }
  if (isAdmin(userId) && pendingAdminCredit.has(userId) && !text.startsWith('/')) {
    try {
      await handleAdminCreditInput(message.chat.id, userId, text);
    } catch (error) {
      pendingAdminCredit.delete(userId);
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Kredit: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminReferral.has(userId) && !text.startsWith('/')) {
    const field = pendingAdminReferral.get(userId);
    const value = parseTokenAmount(text);
    const valid = value !== null && (field === 'reward' ? value > 0 && value <= MAX_REFERRAL_REWARD : value >= 0 && value <= MAX_REFERRAL_CAP);
    if (!valid) {
      const hint = field === 'reward'
        ? `a token amount between 1 and ${formatTokens(MAX_REFERRAL_REWARD)} (e.g. 10000000 or 10M)`
        : `a whole number between 0 and ${formatTokens(MAX_REFERRAL_CAP)} (0 = unlimited)`;
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Invalid value. Send ${hint}.` });
      return;
    }
    pendingAdminReferral.delete(userId);
    try {
      const updated = await setReferralSettings(field === 'reward' ? { rewardTokens: value } : { maxRewardsPerUser: value });
      const notice = field === 'reward'
        ? `\u{2705} Reward set to <b>${formatTokens(updated.rewardTokens)}</b> tokens.`
        : `\u{2705} Max rewarded invites per user: <b>${updated.maxRewardsPerUser ? formatTokens(updated.maxRewardsPerUser) : 'unlimited'}</b>.`;
      const view = await adminReferralView(notice);
      await telegram('sendMessage', { chat_id: message.chat.id, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Could not save: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminRateLimit.has(userId) && !text.startsWith('/')) {
    const { familyIndex, modelIndex } = pendingAdminRateLimit.get(userId);
    const rpm = Number(text.replace(/[.,\s]/g, '').replace(/rpm$/i, ''));
    if (!Number.isInteger(rpm) || rpm < 0 || rpm > RATE_LIMIT_MAX_RPM) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Invalid RPM. Send a whole number between 1 and ${formatTokens(RATE_LIMIT_MAX_RPM)}, or 0 to remove the limit.` });
      return;
    }
    pendingAdminRateLimit.delete(userId);
    try {
      await applyRateLimit(familyIndex, modelIndex, rpm);
      const view = await adminRateLimitFamilyView(familyIndex);
      view.text = `${rpm ? `\u{2705} Limit disimpan: <b>${rpm} RPM</b> per user.` : '\u{2705} Limit dihapus.'}\n\n${view.text}`;
      await telegram('sendMessage', { chat_id: message.chat.id, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Could not save the limit: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminPoll.has(userId) && !text.startsWith('/')) {
    const draft = parsePollInput(text);
    const problem = pollDraftProblem(draft);
    if (problem) {
      // Keep waiting: the admin can resend a corrected poll or press Cancel.
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} ${escapeHtml(problem)}\nSend the poll again, or press Cancel.`, parse_mode: 'HTML' });
      return;
    }
    pendingAdminPoll.delete(userId);
    pollDrafts.set(userId, draft);
    try {
      const view = await adminPollDraftView(draft);
      await telegram('sendMessage', { chat_id: message.chat.id, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Poll: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminBansos.has(userId) && !text.startsWith('/')) {
    try {
      await handleBansosTimeInput(message.chat.id, userId, text);
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} BANSOS: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminUserSearch.has(userId) && !text.startsWith('/')) {
    try {
      await handleUserSearchInput(message.chat.id, userId, text);
    } catch (error) {
      pendingAdminUserSearch.delete(userId);
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Search failed: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminAccess.has(userId) && !text.startsWith('/')) {
    try {
      await handleAccessCodeInput(message.chat.id, userId, text);
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Kode Akses Model: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: adminBackKeyboard() });
    }
    return;
  }
  if (isAdmin(userId) && pendingAdminRedeem.has(userId) && !text.startsWith('/')) {
    const pending = pendingAdminRedeem.get(userId);
    if (pending.step === 'amount') {
      const amount = parseNominal(text);
      if (!amount || amount > MAX_REDEEM_AMOUNT) {
        await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Invalid nominal. Send a number between 1 and ${formatTokens(MAX_REDEEM_AMOUNT)}, e.g. 25000.`, reply_markup: adminRedeemAmountKeyboard() });
        return;
      }
      pendingAdminRedeem.delete(userId);
      await askRedeemUses(message.chat.id, amount);
      return;
    }
    const uses = Number(text.replace(/[.,\s]/g, ''));
    if (!Number.isInteger(uses) || uses < 1 || uses > MAX_REDEEM_USES) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Invalid quota. Send a whole number between 1 and ${formatTokens(MAX_REDEEM_USES)}.` });
      return;
    }
    pendingAdminRedeem.delete(userId);
    await finishAdminRedeemCreate(message.chat.id, userId, pending.amount, uses);
    return;
  }
  const redeemCommand = text.match(/^\/redeem(?:@\w+)?(?:\s+(\S+))?$/i);
  if (redeemCommand) {
    if (redeemCommand[1]) {
      await performUserRedeem(message.chat.id, { ...user, id: userId }, redeemCommand[1]);
    } else {
      pendingUserRedeem.add(userId);
      await telegram('sendMessage', { chat_id: message.chat.id, text: '\u{1F39F}\u{FE0F} Send your redeem code now.' });
    }
    return;
  }
  if ((pendingUserRedeem.has(userId) && !text.startsWith('/')) || REDEEM_CODE_PATTERN.test(text) || ACCESS_CODE_PATTERN.test(text)) {
    pendingUserRedeem.delete(userId);
    await performUserRedeem(message.chat.id, { ...user, id: userId }, text);
    return;
  }
  if (userId === ADMIN_TELEGRAM_ID && pendingAdminTopups.has(userId) && !message.text.startsWith('/')) {
    const targetId = pendingAdminTopups.get(userId);
    pendingAdminTopups.delete(userId);
    const normalized = message.text.replace(/[.\sRp]/gi, '');
    const delta = Number(normalized);
    const backToUser = { inline_keyboard: [[{ text: '\u{1F519} Detail user', callback_data: `admin_topup_user_${targetId}` }]] };
    if (!Number.isFinite(delta) || delta === 0) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Invalid amount. Use +50000 or -10000.', reply_markup: backToUser });
      return;
    }
    const target = await getUser(targetId);
    const newBalance = await adjustBalance(targetId, delta);
    if (!target || newBalance === null) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'User or amount is invalid.', reply_markup: backToUser });
      return;
    }
    const direction = delta > 0 ? 'added' : 'deducted';
    const absolute = Math.abs(delta);
    await telegram('sendMessage', { chat_id: targetId, text: `\u{1F4B0} Balance ${direction}: <b>Rp${absolute.toLocaleString('id-ID')}</b>\nNew balance: <b>Rp${newBalance.toLocaleString('id-ID')}</b>`, parse_mode: 'HTML' }).catch(() => {});
    await sendAdminUserDetail(message.chat.id, userId, targetId, `\u{2705} Saldo ${delta > 0 ? 'ditambah' : 'dikurangi'} <b>${rupiah(absolute)}</b>. Saldo baru: <b>${rupiah(newBalance)}</b>.`);
    return;
  }
  if (userId === ADMIN_TELEGRAM_ID && pendingAdminActions.has(userId) && !message.text.startsWith('/')) {
    pendingAdminActions.delete(userId);
    const announcement = message.text.trim();
    await setAnnouncement(announcement);
    const recipients = await getAllUsers();
    const title = '\u{1F4E2} <b>Announcement</b>';
    const status = await telegram('sendMessage', { chat_id: message.chat.id, text: `${title} \u{2014} \u{23F3} starting\u{2026}`, parse_mode: 'HTML' });
    // Runs in the background: this handler returns now and the bot keeps answering other users.
    startBroadcast({
      label: 'announcement',
      recipients,
      // Plain text, exactly as the admin typed it (no header/template).
      send: (recipient) => telegram('sendMessage', { chat_id: recipient.telegramId, text: announcement }),
      report: async (stats) => editStatusMessage(message.chat.id, status.message_id, broadcastStatusText(title, stats), stats.done ? await adminKeyboard() : undefined),
    });
    return;
  }
  if (await routeTicketMessage(message, userId, user)) return;
  if (message.text === '/ticket') {
    await startUserTicket(message.chat.id, userId);
    return;
  }
  // /dashboard, /topup, /logs, /referral: the same as pressing that button in the menu.
  const menuAction = COMMAND_ACTIONS.get(commandName(text));
  if (menuAction) {
    await handleCallbackQuery({ from: user, message: { chat: message.chat, message_id: message.message_id }, data: menuAction });
    return;
  }
  if (startCommand || message.text === '/menu') {
    if (!account.apiKeys.some((entry) => entry.active !== false)) {
      await createApiKey(user.id || message.chat.id, { firstName: user.first_name, username: user.username });
    }
    // First /start without a saved language: show only the language picker.
    // The normal welcome follows once a language button is pressed.
    if (startCommand && !hasLanguage(account)) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: languagePickerMessage(), parse_mode: 'HTML', reply_markup: languageKeyboard() });
      if (referral) pendingReferralGreeting.set(userId, referral);
      await notifyReferrer(referral);
      return;
    }
    await sendWelcome(message.chat.id, user);
    await announceReferral(message.chat.id, referral, userLanguage(account));
    return;
  }
  if (message.text === '/admin') {
    if (userId !== ADMIN_TELEGRAM_ID) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: 'Access denied.' });
      return;
    }
    await telegram('sendMessage', { chat_id: message.chat.id, text: await adminPanelMessage(), parse_mode: 'HTML', reply_markup: await adminKeyboard() });
    return;
  }
  if (message.text === '/model' || message.text === '/models') {
    try {
      const text = await modelPriceMessage(userId);
      await telegram('sendMessage', { chat_id: message.chat.id, text, parse_mode: 'HTML', reply_markup: modelKeyboard() });
    } catch (error) {
      await telegram('sendMessage', { chat_id: message.chat.id, text: `\u{274C} Could not sync models: ${escapeHtml(error.message)}`, parse_mode: 'HTML', reply_markup: menuKeyboard() });
    }
    return;
  }
  await telegram('sendMessage', { chat_id: message.chat.id, text: 'Please use the menu below. \u{1F447}', reply_markup: menuKeyboard(userId) });
}

// ---------- Command menu ----------
// The "Menu" button next to the message box lists these, so a user taps a command instead of
// typing it. They are registered with Telegram (setMyCommands) every time the bot starts, so
// this list is the source of truth and replaces whatever was set by hand in BotFather
// (/setcommands). Descriptions follow the language of the user's Telegram app: Indonesian for
// "id", English for every other language. /admin is listed only in the admin's own chat.
const BOT_COMMANDS = [
  { command: 'start', id: 'Mulai bot / tampilkan menu utama', en: 'Start the bot / show the main menu' },
  { command: 'menu', id: 'Menu utama', en: 'Main menu' },
  { command: 'dashboard', id: 'API Dashboard: API key & pemakaian', en: 'API dashboard: keys & usage' },
  { command: 'kredit', id: 'Kredit token: saldo, paket & multiplier', en: 'Token credits: balance, packages & multipliers' },
  { command: 'topup', id: 'Beli kredit / isi saldo', en: 'Buy credits / top up' },
  { command: 'model', id: 'Daftar model & harga', en: 'Model list & prices' },
  { command: 'logs', id: 'Riwayat pemakaian API terbaru', en: 'Recent API usage' },
  { command: 'usage', id: 'Ringkasan pemakaian per model', en: 'Usage summary per model' },
  { command: 'redeem', id: 'Tukar kode redeem', en: 'Redeem a code' },
  { command: 'referral', id: 'Undang teman, dapat bonus token', en: 'Invite friends, earn bonus tokens' },
  { command: 'ticket', id: 'Hubungi admin lewat ticket', en: 'Contact support with a ticket' },
  { command: 'admin', id: 'Panel admin', en: 'Admin panel', admin: true },
];
// Which description set serves which Telegram app language ('' = every other language).
const COMMAND_LANGUAGES = [
  { languageCode: 'id', text: 'id' },
  { languageCode: 'en', text: 'en' },
  { languageCode: '', text: 'en' },
];
// Commands that do exactly what a main-menu button does: command -> that button's callback_data.
const COMMAND_ACTIONS = new Map([['dashboard', 'dashboard'], ['kredit', 'credits'], ['credits', 'credits'], ['topup', 'top_up'], ['logs', 'logs'], ['usage', 'usage'], ['referral', 'referral']]);

// "/topup" or "/topup@MyBot" -> "topup". Null for other text, and for a command meant for a
// different bot (in a group).
function commandName(text) {
  const match = String(text || '').trim().match(/^\/([a-z0-9_]{1,32})(?:@(\w+))?$/i);
  if (!match) return null;
  if (match[2] && botUsername && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return match[1].toLowerCase();
}

function commandList(text, forAdmin) {
  return BOT_COMMANDS.filter((entry) => forAdmin || !entry.admin).map((entry) => ({ command: entry.command, description: entry[text] }));
}

let adminCommandsReady = false;
let adminCommandsBusy = false;

// The admin's own list: the same commands plus /admin. Telegram refuses this ("chat not found")
// until the admin has opened the bot once, so startup only tries, and the admin's next message
// tries again (handleMessage). Never throws.
function ensureAdminCommands() {
  if (adminCommandsReady || adminCommandsBusy) return Promise.resolve(adminCommandsReady);
  adminCommandsBusy = true;
  const scope = { type: 'chat', chat_id: Number(ADMIN_TELEGRAM_ID) };
  return (async () => {
    for (const { languageCode, text } of COMMAND_LANGUAGES) {
      await telegram('setMyCommands', { commands: commandList(text, true), scope, ...(languageCode ? { language_code: languageCode } : {}) });
    }
    adminCommandsReady = true;
    console.log('[commands] Admin menu registered (with /admin)');
  })()
    .catch((error) => console.error('[commands] Admin menu not set yet:', error.message))
    .then(() => {
      adminCommandsBusy = false;
      return adminCommandsReady;
    });
}

// Registers the command menu for everyone and makes the Menu button show it. A failure is
// logged and never stops the bot.
async function registerBotCommands() {
  try {
    for (const { languageCode, text } of COMMAND_LANGUAGES) {
      await telegram('setMyCommands', { commands: commandList(text, false), scope: { type: 'default' }, ...(languageCode ? { language_code: languageCode } : {}) });
    }
    // The Menu button may have been switched to something else in BotFather; make it list commands.
    await telegram('setChatMenuButton', { menu_button: { type: 'commands' } });
    console.log(`[commands] Menu registered: ${commandList('en', false).length} commands (id, en)`);
  } catch (error) {
    console.error('[commands] Could not register the command menu:', error.message);
  }
  await ensureAdminCommands();
}

function isRequiredGroupMember(member) {
  return ['creator', 'administrator', 'member'].includes(member?.status)
    || (member?.status === 'restricted' && member.is_member === true);
}

async function checkRequiredGroupAccess(bot) {
  await Promise.all(REQUIRED_GROUPS.map(async group => {
    try {
      const member = await telegram('getChatMember', { chat_id: group.chatId, user_id: bot.id });
      if (!['administrator', 'creator'].includes(member?.status)) throw new Error('bot belum menjadi admin grup');
      console.log(`[membership] Ready: bot is admin in ${group.chatId}`);
    } catch (error) {
      console.error(`[membership] Jadikan bot admin di ${group.chatId} agar verifikasi anggota bisa berjalan: ${error.message}`);
    }
  }));
}

function requiredGroupButtons() {
  return REQUIRED_GROUPS.map(group => [{ text: `\u{1F465} Join ${group.name}`, url: group.url }]);
}

function groupJoinView(referralCode = '', checks = []) {
  return {
    text: [
      '\u{1F512} <b>Gabung ke kedua grup dulu, yuk!</b>', '',
      'Sebelum melanjutkan, join ke kedua grup berikut untuk mengakses semua fitur bot:',
      ...REQUIRED_GROUPS.map(group => {
        const check = checks.find(item => item.chatId === group.chatId);
        const state = check ? (check.unavailable ? 'belum bisa diperiksa' : check.joined ? 'sudah bergabung' : 'belum bergabung') : '';
        return `\u{2022} <b>${group.name}</b>${state ? `: ${state}` : ''}`;
      }), '',
      'Tekan tombol grup di bawah untuk bergabung, lalu tekan <b>Verifikasi Ulang</b>.',
      ...(checks.some(check => check.unavailable) ? ['', '\u{26A0}\u{FE0F} Keanggotaan belum bisa diperiksa saat ini. Silakan coba Verifikasi Ulang beberapa saat lagi.'] : []),
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      ...requiredGroupButtons(),
      [{ text: '\u{1F504} Verifikasi Ulang', callback_data: GROUP_VERIFY_ACTION + (referralCode ? `:${referralCode}` : '') }],
    ] },
  };
}

async function requiredGroupMembership(userId) {
  return Promise.all(REQUIRED_GROUPS.map(async group => {
    try {
      const member = await telegram('getChatMember', { chat_id: group.chatId, user_id: userId });
      return { chatId: group.chatId, joined: isRequiredGroupMember(member), unavailable: false };
    } catch (error) {
      console.error(`[membership] ${group.chatId}: check failed: ${error.message}`);
      return { chatId: group.chatId, joined: false, unavailable: true };
    }
  }));
}

function adminGroupView(notice = '') {
  const running = membershipBroadcastStats && !membershipBroadcastStats.done;
  return {
    text: [
      ...(notice ? [notice, ''] : []),
      '\u{1F465} <b>VERIFIKASI SEMUA USER</b>', '',
      'Wajib join <b>kedua grup</b> berlaku untuk semua pengguna lama dan baru.',
      ...REQUIRED_GROUPS.map(group => `\u{2022} <b>${group.name}</b>`), '',
      'Semua fitur bot diperiksa saat digunakan. Sudah join satu grup saja belum cukup.',
      'Kirim pesan verifikasi ke seluruh pengguna terdaftar dengan dua tombol grup dan Verifikasi Ulang.',
      ...(running ? ['', '\u{23F3} Pengiriman verifikasi sedang berjalan. Lihat pesan progres sebelumnya.'] : []),
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      ...requiredGroupButtons(),
      ...(!running ? [[{ text: '\u{1F4E8} Verifikasi Semua User', callback_data: 'admin_group_prepare' }]] : []),
      [{ text: '\u{1F519} Kembali ke Admin Panel', callback_data: 'admin_panel' }],
    ] },
  };
}

async function handleAdminGroupAction(query, action) {
  // Also enforce this here so future callers cannot accidentally bypass the admin gate.
  if (!isAdmin(query.from.id)) return null;
  if (action === 'admin_groups') {
    membershipBroadcastDraft = null;
    return showAdminView(query, adminGroupView());
  }
  if (membershipBroadcastStats && !membershipBroadcastStats.done) return showAdminView(query, adminGroupView());
  if (action === 'admin_group_prepare') {
    const users = await getAllUsers();
    const token = crypto.randomBytes(6).toString('hex');
    membershipBroadcastDraft = { token, expiresAt: Date.now() + 10 * 60 * 1000 };
    const view = groupJoinView();
    return showAdminView(query, {
      text: `\u{1F4E8} <b>Kirim verifikasi ke ${formatTokens(users.length)} user?</b>\n\nPesan yang diterima pengguna:\n\n${view.text}`,
      reply_markup: { inline_keyboard: [
        ...requiredGroupButtons(),
        [{ text: '\u{2705} Kirim Verifikasi ke Semua User', callback_data: `admin_group_send_${token}` }],
        [{ text: '\u{1F519} Batal', callback_data: 'admin_groups' }],
      ] },
    });
  }
  const token = action.slice('admin_group_send_'.length);
  if (!membershipBroadcastDraft || membershipBroadcastDraft.token !== token || membershipBroadcastDraft.expiresAt < Date.now()) {
    return showAdminView(query, adminGroupView('Tombol kirim sudah tidak berlaku. Buka pratinjau baru untuk mengirim verifikasi.'));
  }
  // Consume once before awaiting anything: repeated clicks cannot start duplicate jobs.
  membershipBroadcastDraft = null;
  membershipBroadcastStats = { done: false };
  try {
    const recipients = await getAllUsers();
    const view = groupJoinView();
    const title = '\u{1F465} <b>Pengiriman verifikasi grup</b>';
    await showAdminView(query, { text: `${title}\n\u{23F3} Menyiapkan pengiriman...`, reply_markup: { inline_keyboard: [] } });
    membershipBroadcastStats = startBroadcast({
      label: 'group verification', recipients,
      send: recipient => telegram('sendMessage', {
        chat_id: recipient.telegramId,
        text: `\u{1F514} <b>Verifikasi semua user</b>\n\n${view.text}`,
        parse_mode: 'HTML', reply_markup: view.reply_markup,
      }),
      report: stats => editStatusMessage(query.message.chat.id, query.message.message_id, broadcastStatusText(title, stats), {
        inline_keyboard: stats.done ? [[{ text: '\u{1F519} Verifikasi Grup', callback_data: 'admin_groups' }]] : [],
      }),
    });
  } catch (error) {
    membershipBroadcastStats = null;
    return showAdminView(query, adminGroupView(`\u{274C} Pengiriman belum dimulai: ${escapeHtml(error.message)}`));
  }
  return null;
}

// Gate every incoming private interaction before creating accounts, API keys,
// referral rewards, payments, tickets or running a previously sent menu button.
// No membership cache: leaving the group locks the next bot interaction again.
async function handleBotUpdate(update) {
  const query = update.callback_query;
  const message = query?.message || update.message;
  const from = query?.from || message?.from;
  // The bot must be a group admin to check members. Ignore group traffic so
  // ordinary group messages cannot trigger menus or expose personal API keys.
  if (message?.chat?.type !== 'private' || !from?.id || from.is_bot) return;
  if (query && typeof query.data !== 'string') return;
  if (query?.id) {
    await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  }
  const verification = query?.data.match(/^group_verify(?::(ref_[a-f0-9]{10}))?$/);
  const startCode = query ? undefined : message.text?.trim().match(/^\/start(?:@\w+)?\s+(ref_[a-f0-9]{10})$/i)?.[1];
  // Keep the referral in the verification button, so a bot restart while the
  // user joins does not lose it. Credit the inviter only after membership passes.
  const referralCode = verification?.[1] || startCode?.toLowerCase() || '';
  const checks = await requiredGroupMembership(from.id);
  if (!checks.every(check => check.joined)) {
    clearPendingInput(from.id);
    const view = groupJoinView(referralCode, checks);
    return telegram('sendMessage', {
      chat_id: message.chat.id, ...view, parse_mode: 'HTML',
    });
  }
  if (verification) {
    await telegram('editMessageText', {
      chat_id: message.chat.id, message_id: message.message_id,
      text: '\u{2705} Keanggotaan terverifikasi! Kamu sudah bisa menggunakan bot.',
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    return handleMessage({ from, chat: message.chat, text: `/start${referralCode ? ` ${referralCode}` : ''}` });
  }
  if (query) return handleCallbackQuery({ ...query, id: undefined });
  return handleMessage(message);
}

async function poll() {
  try {
    const updates = await telegram('getUpdates', { offset: updateOffset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      await handleBotUpdate(update);
    }
  } catch (error) {
    console.error('[telegram]', error.message);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  setImmediate(poll);
}

telegram('deleteWebhook').then(() => telegram('getMe')).then((bot) => {
  botUsername = bot.username || '';
  console.log(`Telegram bot @${bot.username} is running.`);
  console.log(`[data] Using ${dataMode}`);
  // On split hosting the API sends testimonials; never start another sender
  // against independent local files on the remote bot host.
  if (dataMode === 'local files') {
    require('./payment-testimonials').createPaymentTestimonialWorker({
      sources: [require('./credit-store'), require('./usage-db')].map(store => ({
        list: store.listPendingPaymentTestimonials,
        claim: store.claimPaymentTestimonial,
        complete: store.completePaymentTestimonial,
      })),
    }).start();
  }
  checkRequiredGroupAccess(bot);
  // Not awaited: the command menu must never delay or stop the bot (errors are logged inside).
  registerBotCommands();
  // Connectivity check at startup so a wrong DATA_API_URL shows up immediately in the log.
  countOpenTickets()
    .then(() => console.log('[data] Connection OK'))
    .catch((error) => console.error('[data] Connection check FAILED:', error.message));
  return poll();
}).catch((error) => {
  console.error('[telegram] startup failed:', error.message);
  process.exit(1);
});

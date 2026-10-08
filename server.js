require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { findUserByApiKey, recordAdminRequest, recordUsage, settleOrder } = require('./usage-db');
const usageDb = require('./usage-db');
const adminSettings = require('./admin-settings');
const { PINNED_MODELS, getModelFamily, stripModelPrefix } = require('./pricing');
const { isAllModelsFree } = require('./admin-settings');
const moderation = require('./moderation');
const creditRules = require('./credit-rules');
const creditConfig = require('./credit-config');
const creditStore = require('./credit-store');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
// Support both the project-specific name and the name used by OpenAI clients.
const API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
const CASHI_SECRET_KEY = process.env.CASHI_SECRET_KEY;
const modelCachePath = usageDb.modelCachePath || path.join(__dirname, 'data', 'models.json');

if (!UPSTREAM_BASE_URL) {
  console.error('UPSTREAM_BASE_URL is not set. Refusing to start.');
  process.exit(1);
}

// Last line of defence: a busy database is temporary and is thrown before anything was
// written, so it must never take the whole API down. Every other uncaught error keeps
// Node's default outcome (log and exit with code 1, the supervisor restarts the service).
// Also receives unhandled promise rejections (origin 'unhandledRejection').
// The message test also recognises the error from an older usage-db.js upload.
const isDbBusy = (error) => error?.code === 'EDB_BUSY' || /is busy; try again$/.test(String(error?.message || ''));
process.on('uncaughtException', (error, origin) => {
  if (isDbBusy(error)) {
    console.error(`[db] uncaught busy error ignored (${origin}):`, error.stack || error.message);
    return;
  }
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

// Database writes that run after a response (usage billing, request log, prompt log) happen
// in event listeners, outside Express's error handling: a throw there used to kill the
// process. A busy database is retried later with exponential backoff (non-blocking);
// other failures are logged.
const DB_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
function runDbWrite(label, write, onDone, attempt = 0) {
  let result;
  try {
    result = write();
  } catch (error) {
    if (isDbBusy(error) && attempt < DB_RETRY_DELAYS_MS.length) {
      const delay = DB_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250);
      console.warn(`[db] ${label}: ${error.message} (retry ${attempt + 1}/${DB_RETRY_DELAYS_MS.length} in ${delay} ms)`);
      setTimeout(() => runDbWrite(label, write, onDone, attempt + 1), delay);
      return;
    }
    console.error(`[db] ${label} NOT saved${attempt ? ` after ${attempt + 1} attempts` : ''}:`, error.message);
    return;
  }
  if (!onDone) return;
  try {
    onDone(result);
  } catch (error) {
    console.error(`[db] ${label}: follow-up failed:`, error.message);
  }
}

const app = express();

// Request logging: method, path, status, response time, response size.
app.use(morgan('dev'));

// Cashi payment webhook. Cashi signs the exact raw request body with HMAC-SHA256.
app.post('/webhooks/cashi', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.get('x-gateway-signature');
  if (!CASHI_SECRET_KEY || !signature || !Buffer.isBuffer(req.body)) {
    return res.status(401).send('Invalid webhook');
  }
  const expected = crypto.createHmac('sha256', CASHI_SECRET_KEY).update(req.body).digest('hex');
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid JSON');
  }
  // Token credit / unlimited orders are credited once, only when the paid amount covers the
  // order price (credit-store.js); every other order id is the old Rupiah top-up.
  if (event.event === 'PAYMENT_SETTLED' && event.data?.status === 'SETTLED') {
    const result = creditStore.settlePayment(event.data.order_id, event.data.amount, event.data.status, { source: 'webhook' });
    if (result && result.settled === false && result.reason) {
      console.warn(`[cashi] order ${String(event.data.order_id).slice(0, 80)} not credited: ${result.reason}`);
    }
  }
  return res.send('OK');
});

// Internal data API for a Telegram bot running on a different host.
// The bot signs every request with HMAC-SHA256(INTERNAL_API_SECRET, "<timestamp>.<body>"),
// so the secret itself never travels over the network. Disabled unless the secret is set.
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const INTERNAL_MAX_SKEW_MS = 5 * 60 * 1000;
const INTERNAL_FUNCTIONS = {
  ensureUser: usageDb.ensureUser,
  setUserLanguage: usageDb.setUserLanguage,
  createApiKey: usageDb.createApiKey,
  getUser: usageDb.getUser,
  getAllUsers: usageDb.getAllUsers,
  getAdminLogs: usageDb.getAdminLogs,
  adjustBalance: usageDb.adjustBalance,
  getOrder: usageDb.getOrder,
  revokeApiKey: usageDb.revokeApiKey,
  createOrder: usageDb.createOrder,
  settleOrder: usageDb.settleOrder,
  createRedeemCode: usageDb.createRedeemCode,
  redeemCode: usageDb.redeemCode,
  listRedeemCodes: usageDb.listRedeemCodes,
  disableRedeemCode: usageDb.disableRedeemCode,
  // Model access codes. createAccessCode / disableAccessCode refuse anyone but ADMIN_TELEGRAM_ID.
  createAccessCode: usageDb.createAccessCode,
  redeemAccessCode: usageDb.redeemAccessCode,
  listAccessCodes: usageDb.listAccessCodes,
  getAccessCode: usageDb.getAccessCode,
  disableAccessCode: usageDb.disableAccessCode,
  getModelAccess: usageDb.getModelAccess,
  getUsageSummary: usageDb.getUsageSummary,
  listUsersPage: usageDb.listUsersPage,
  getAdminStats: usageDb.getAdminStats,
  resetStats: usageDb.resetStats,
  getReferralInfo: usageDb.getReferralInfo,
  startWithReferral: usageDb.startWithReferral,
  getReferralSettings: adminSettings.getReferralSettings,
  setReferralSettings: adminSettings.setReferralSettings,
  createTicket: usageDb.createTicket,
  addTicketMessage: usageDb.addTicketMessage,
  linkAdminMessage: usageDb.linkAdminMessage,
  findTicketByAdminMessage: usageDb.findTicketByAdminMessage,
  getTicket: usageDb.getTicket,
  getOpenTicketForUser: usageDb.getOpenTicketForUser,
  listTickets: usageDb.listTickets,
  countOpenTickets: usageDb.countOpenTickets,
  closeTicket: usageDb.closeTicket,
  createPoll: usageDb.createPoll,
  votePoll: usageDb.votePoll,
  getPoll: usageDb.getPoll,
  listPolls: usageDb.listPolls,
  closePoll: usageDb.closePoll,
  setPollSent: usageDb.setPollSent,
  listPromptUsers: usageDb.listPromptUsers,
  getUserPrompts: usageDb.getUserPrompts,
  clearPrompts: usageDb.clearPrompts,
  clearAllPrompts: usageDb.clearAllPrompts,
  isPromptLogEnabled: adminSettings.isPromptLogEnabled,
  setPromptLogEnabled: adminSettings.setPromptLogEnabled,
  readSettings: adminSettings.readSettings,
  isAllModelsFree: adminSettings.isAllModelsFree,
  setAllModelsFree: adminSettings.setAllModelsFree,
  isPaymentsEnabled: adminSettings.isPaymentsEnabled,
  setPaymentsEnabled: adminSettings.setPaymentsEnabled,
  setAnnouncement: adminSettings.setAnnouncement,
  getDisabledModels: adminSettings.getDisabledModels,
  setModelDisabled: adminSettings.setModelDisabled,
  setFamilyDisabled: adminSettings.setFamilyDisabled,
  getRateLimits: adminSettings.getRateLimits,
  setModelRateLimit: adminSettings.setModelRateLimit,
  setFamilyRateLimit: adminSettings.setFamilyRateLimit,
  listBansos: adminSettings.listBansos,
  createBansos: adminSettings.createBansos,
  stopBansos: adminSettings.stopBansos,
  getModerationSettings: adminSettings.getModerationSettings,
  setModerationSettings: adminSettings.setModerationSettings,
  listModerationBlocks: usageDb.listModerationBlocks,
  getModerationBlock: usageDb.getModerationBlock,
  clearModerationBlocks: usageDb.clearModerationBlocks,
  // Token credits. Writes that change money or configuration check ADMIN_TELEGRAM_ID themselves.
  getCreditOverview: creditStore.getCreditOverview,
  getCreditOrder: creditStore.getCreditOrder,
  createCreditOrder: creditStore.createCreditOrder,
  markCreditOrderFailed: creditStore.markCreditOrderFailed,
  settlePayment: creditStore.settlePayment,
  adminConfirmCreditOrder: creditStore.adminConfirmCreditOrder,
  adjustCredits: creditStore.adjustCredits,
  refundCredits: creditStore.refundCredits,
  getCreditStats: creditStore.getCreditStats,
  listCreditOrders: creditStore.listCreditOrders,
  getCreditCatalog: creditConfig.getCreditCatalog,
  getCreditAdmin: creditConfig.getCreditAdmin,
  updateCreditConfig: creditConfig.updateCreditConfig,
  // The bot syncs the model list; the proxy needs its aliases to route requests.
  saveModelCache: (cache) => {
    fs.mkdirSync(path.dirname(modelCachePath), { recursive: true });
    fs.writeFileSync(modelCachePath, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  },
};

function validInternalSignature(req) {
  const timestamp = Number(req.get('x-internal-timestamp'));
  const signature = String(req.get('x-internal-signature') || '');
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > INTERNAL_MAX_SKEW_MS) return false;
  const expected = crypto.createHmac('sha256', INTERNAL_API_SECRET).update(`${timestamp}.`).update(req.body).digest('hex');
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return provided.length === expectedBuffer.length && crypto.timingSafeEqual(provided, expectedBuffer);
}

app.post('/internal/rpc', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!INTERNAL_API_SECRET) return res.status(404).json({ ok: false, error: 'Internal API disabled' });
  if (!Buffer.isBuffer(req.body) || !validInternalSignature(req)) return res.status(401).json({ ok: false, error: 'Invalid signature' });
  let call;
  try {
    call = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }
  const known = Object.prototype.hasOwnProperty.call(INTERNAL_FUNCTIONS, call?.fn);
  const fn = known ? INTERNAL_FUNCTIONS[call.fn] : null;
  if (known && typeof fn !== 'function') {
    return res.status(501).json({ ok: false, error: `${call.fn} is missing on the API server: upload the latest usage-db.js and admin-settings.js there` });
  }
  if (!fn || !Array.isArray(call.args)) return res.status(400).json({ ok: false, error: 'Unknown function' });
  try {
    const result = fn(...call.args);
    return res.json({ ok: true, result: result === undefined ? null : result });
  } catch (error) {
    console.error(`[internal] ${call.fn} failed:`, error.message);
    // Busy: nothing was written, the bot retries the call (data-client.js).
    if (isDbBusy(error)) {
      res.set('Retry-After', '1');
      return res.status(503).json({ ok: false, error: error.message, code: 'EDB_BUSY' });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Admin statistics API: every metric shown in the bot's Admin Panel, as one JSON response.
//   GET /admin/stats   Authorization: Bearer sk-user-...   (or x-api-key)
// Auth reuses the existing user API keys: only an active key owned by the admin's Telegram
// account passes. ADMIN_TELEGRAM_ID has the same value and default as in telegram-bot.js.
// Mounted outside /v1, so it skips the balance gate, rate limits and request-log counters.
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '6957236291').trim();
const ADMIN_TOP_LIST_SIZE = 10;

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function adminUserRef(user) {
  return { telegramId: String(user.telegramId), firstName: user.firstName || '', username: user.username || '' };
}

function buildAdminStats() {
  const s = usageDb.getAdminStats();
  const settings = adminSettings.readSettings();
  const referral = adminSettings.getReferralSettings();
  const disabled = adminSettings.getDisabledModels();
  const users = usageDb.getAllUsers();
  const tickets = usageDb.listTickets();
  const openTickets = tickets.filter((ticket) => ticket.status === 'open').length;

  // Same ranking as the bot's "Top Users" screen (by total tokens).
  const topUsers = [...users]
    .sort((a, b) => Number(b.stats?.totalTokens || 0) - Number(a.stats?.totalTokens || 0))
    .slice(0, ADMIN_TOP_LIST_SIZE)
    .map((user) => ({
      ...adminUserRef(user),
      requests: Number(user.stats?.requests || 0),
      errors: Number(user.stats?.errors || 0),
      totalTokens: Number(user.stats?.totalTokens || 0),
      spent: roundMoney(user.stats?.spent),
      balance: roundMoney(user.balance),
      bonusTokens: Number(user.bonusTokens || 0),
    }));

  // Same ranking as the bot's Referral screen (by invites, then tokens earned).
  const topReferrers = users
    .filter((user) => Number(user.referralStats?.invites || 0) > 0)
    .sort((a, b) => Number(b.referralStats.invites || 0) - Number(a.referralStats.invites || 0)
      || Number(b.referralStats.tokensEarned || 0) - Number(a.referralStats.tokensEarned || 0))
    .slice(0, ADMIN_TOP_LIST_SIZE)
    .map((user) => ({
      ...adminUserRef(user),
      invites: Number(user.referralStats.invites || 0),
      rewarded: Number(user.referralStats.rewarded || 0),
      tokensEarned: Number(user.referralStats.tokensEarned || 0),
      bonusTokensLeft: Number(user.bonusTokens || 0),
    }));

  return {
    generatedAt: new Date().toISOString(),
    statsSince: s.statsResetAt || null,
    currency: 'IDR',
    summary: {
      users: s.totalUsers,
      requests: s.requests,
      paidTopups: roundMoney(s.revenue),
      openTickets,
    },
    users: {
      total: s.totalUsers,
      new24h: s.newUsers24h,
      active: s.activeUsers,
      activeApiKeys: s.activeKeys,
    },
    requests: {
      total: s.requests,
      success: s.success,
      errors: s.errors,
      successRate: Math.round(s.successRate * 100) / 100,
      last24h: { ...s.last24h },
    },
    tokens: {
      input: s.inputTokens,
      output: s.outputTokens,
      total: s.totalTokens,
    },
    finance: {
      usageBilled: roundMoney(s.spent),
      paidTopups: { amount: roundMoney(s.revenue), settledOrders: s.settledOrders, pendingOrders: s.pendingOrders },
      redeemed: { amount: roundMoney(s.redeemedAmount), count: s.redemptions },
      usersTotalBalance: roundMoney(s.totalBalance),
    },
    redeemCodes: {
      created: s.redeemCodes,
      active: s.activeRedeemCodes,
    },
    referral: {
      enabled: referral.enabled,
      rewardTokens: referral.rewardTokens,
      maxRewardsPerUser: referral.maxRewardsPerUser, // 0 = unlimited
      invites: s.referralInvites,
      rewarded: s.referralRewarded,
      tokensAwarded: s.referralTokensAwarded,
      bonusTokensLeft: s.bonusTokensLeft,
      bonusTokensUsed: s.bonusTokensUsed,
      topReferrers,
    },
    tickets: {
      open: openTickets,
      closed: tickets.length - openTickets,
      total: tickets.length,
    },
    settings: {
      freeMode: settings.allModelsFree === true,
      paymentsEnabled: settings.paymentsEnabled !== false,
      disabledFamilies: disabled.families,
      disabledModels: disabled.models,
      rateLimits: adminSettings.getRateLimits(),
      announcement: settings.announcement || '',
      announcementAt: settings.announcementAt || null,
    },
    topUsers,
    // Token credits (separate from the Rupiah balance above).
    credits: (() => {
      try {
        return creditStore.getCreditStats();
      } catch (error) {
        return { error: error.message };
      }
    })(),
  };
}

app.get('/admin/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const apiKey = getClientApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'API key is required', type: 'missing_api_key' } });
  try {
    const user = apiKey.startsWith('sk-user-') ? findUserByApiKey(apiKey) : null;
    if (!user) return res.status(401).json({ error: { message: 'Invalid or revoked API key', type: 'invalid_api_key' } });
    if (String(user.telegramId) !== ADMIN_TELEGRAM_ID) {
      return res.status(403).json({ error: { message: 'Admin access only', type: 'forbidden' } });
    }
    return res.json(buildAdminStats());
  } catch (error) {
    console.error('[admin] stats failed:', error.message);
    return res.status(500).json({ error: { message: 'Could not build admin stats', type: 'server_error' } });
  }
});

// ---------- Admin stats Mini App (Telegram Web App) ----------
// Bot: Admin Panel -> "Stats Mini App" opens GET /admin/app inside Telegram. The page holds no
// data: it calls GET /admin/app/stats with `Authorization: tma <initData>`, the launch data that
// Telegram signs with this bot's token. The server checks that signature and its age, and only
// answers when the signed Telegram user id is ADMIN_TELEGRAM_ID -- the same admin check as
// /admin/stats and the bot's Admin Panel. Nothing the page says about itself is trusted.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Needs TELEGRAM_BOT_TOKEN (the bot's own token) on this host; without it the endpoint stays off.
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const STORE_NAME = process.env.STORE_NAME || 'X Store'; // same default as telegram-bot.js
const ADMIN_APP_PAGE = path.join(__dirname, 'admin-app.html');
const ADMIN_APP_MAX_AGE_SECONDS = 60 * 60; // after an hour the admin reopens the Mini App
const ADMIN_APP_CLOCK_SKEW_SECONDS = 5 * 60; // same tolerance as the internal RPC
const MAX_INIT_DATA_LENGTH = 4096;

// { user } for genuine, fresh Telegram init data; otherwise { error: 'invalid' | 'expired' }.
function verifyTelegramInitData(raw) {
  if (!TELEGRAM_BOT_TOKEN || !raw || raw.length > MAX_INIT_DATA_LENGTH) return { error: 'invalid' };
  const params = new URLSearchParams(raw);
  const hash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(hash)) return { error: 'invalid' };
  // Data-check-string: every received field except `hash`, as key=value, sorted, one per line.
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return { error: 'invalid' };
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age > ADMIN_APP_MAX_AGE_SECONDS || age < -ADMIN_APP_CLOCK_SKEW_SECONDS) return { error: 'expired' };
  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (_) {
    // A signed but unreadable user field cannot identify anyone.
  }
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) return { error: 'invalid' };
  return { user };
}

// Everything /admin/stats returns, plus the store name and the BANSOS windows and polls, which
// have their own admin screens. Older admin-settings.js / usage-db.js files without those
// features simply report none, so a partial upload cannot break the Mini App.
function buildAdminAppStats() {
  const bansos = typeof adminSettings.listBansos === 'function'
    ? adminSettings.listBansos()
      .filter((entry) => entry.status === 'active' || entry.status === 'scheduled')
      .map(({ id, models, families, startsAt, endsAt, status }) => ({ id, models, families, startsAt, endsAt, status }))
    : [];
  const polls = typeof usageDb.listPolls === 'function' ? usageDb.listPolls(20) : [];
  return { storeName: STORE_NAME, ...buildAdminStats(), bansos, polls };
}

app.get('/admin/app', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(ADMIN_APP_PAGE, (error) => {
    if (error && !res.headersSent) {
      res.status(404).type('text/plain').send('Admin Mini App page is missing: upload admin-app.html next to server.js.');
    }
  });
});

app.get('/admin/app/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ error: { message: 'The Mini App is not set up on the server: set TELEGRAM_BOT_TOKEN (the bot token) for server.js and restart it.', type: 'not_configured' } });
  }
  const match = String(req.get('authorization') || '').match(/^tma\s+(\S+)$/i);
  if (!match) {
    return res.status(401).json({ error: { message: 'Open this Mini App from the bot: Admin Panel -> Stats Mini App.', type: 'missing_init_data' } });
  }
  const auth = verifyTelegramInitData(match[1]);
  if (auth.error === 'expired') {
    return res.status(401).json({ error: { message: 'This session has expired. Close the Mini App and open it again from the Admin Panel.', type: 'expired_init_data' } });
  }
  if (auth.error) {
    return res.status(401).json({ error: { message: 'Telegram login data could not be verified. Open the Mini App again from the Admin Panel.', type: 'invalid_init_data' } });
  }
  if (String(auth.user.id) !== ADMIN_TELEGRAM_ID) {
    return res.status(403).json({ error: { message: 'Admin access only', type: 'forbidden' } });
  }
  try {
    return res.json(buildAdminAppStats());
  } catch (error) {
    console.error('[admin-app] stats failed:', error.message);
    return res.status(500).json({ error: { message: 'Could not build admin stats', type: 'server_error' } });
  }
});

// OpenAI requests are JSON. Parse them so unsupported model families can be
// rejected before they consume upstream capacity, then restore the body for HPM.
app.use('/v1', (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const usage = req.usageDetails || {};
    const entry = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.userRecord?.telegramId || null,
      model: req.body?.model || req.requestModel || null,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: usage.totalTokens || 0,
      pricePerMillion: usage.pricePerMillion || 0,
      cost: usage.cost || 0,
      balanceAfter: usage.balanceAfter,
      ...(req.billing?.funding ? { funding: req.billing.funding } : {}),
      ...(usage.credits !== undefined ? { credits: usage.credits, multiplier: usage.multiplier } : {}),
      ...(usage.estimated ? { estimated: true } : {}),
    };
    // Written after the response, outside Express's error handling: a busy database is retried.
    runDbWrite(`request log ${entry.method} ${entry.path}`, () => recordAdminRequest(entry));
  });
  next();
});
app.use('/v1', express.json({ limit: '10mb' }));
app.use('/v1', (req, res, next) => {
  const model = req.body && req.body.model;
  if (model && !getModelFamily(model)) {
    return res.status(403).json({
      error: {
        message: `Model '${model}' is not available. Supported families: Groq, Qwen, ChatGPT, Hy, DeepSeek, GLM, Kimi, Gemini, MiniMax, Claude.`,
        type: 'model_not_supported',
      },
    });
  }
  // A disabled model stays usable for a caller whose active model access code includes it.
  if (model && adminSettings.isModelDisabled(model, getModelFamily(model)) && !hasExclusiveAccess(req, model)) {
    return res.status(403).json({
      error: {
        message: `Model '${model}' is currently disabled by the admin. Please choose another model.`,
        type: 'model_disabled',
      },
    });
  }
  if (model && req.body) {
    // Display name for pricing / credits, upstream route ("cbcn/glm-5.2") for the provider.
    req.displayModel = stripModelPrefix(String(model)).trim().toLowerCase();
    req.body.model = resolveUpstreamModel(model);
    req.upstreamModel = String(req.body.model);
  }
  next();
});

function getClientApiKey(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  // OpenCode uses Authorization: Bearer. Some OpenAI-compatible clients use
  // x-api-key, so accept that equivalent header as well.
  return (match && match[1].trim()) || (req.headers['x-api-key'] && String(req.headers['x-api-key']).trim());
}

// Active BANSOS window (admin: Admin Panel -> BANSOS) covering this model, or null.
// Tolerates an admin-settings.js uploaded before BANSOS existed, so an outdated
// file cannot break every API request.
function bansosFor(model) {
  if (!model || typeof adminSettings.getBansosFor !== 'function') return null;
  const displayName = stripModelPrefix(model);
  return adminSettings.getBansosFor(displayName, getModelFamily(displayName));
}

// Model access codes (bot: Redeem Code with an MDL-... code). While a redeemed code is active,
// the user may use that code's models even when the admin has disabled them for everyone else.
// It only ADDS access: every other model works exactly as for any user. Worked out from the clock
// on every request, so the extra access ends by itself with the period. Null = no extra access.
// Tolerates a usage-db.js uploaded before access codes existed: nobody gets extra access then.
function activeModelAccess(user) {
  if (!user || typeof usageDb.modelAccessFor !== 'function') return null;
  const access = usageDb.modelAccessFor(user);
  return access && access.granted && Array.isArray(access.models) && access.models.length ? access : null;
}

// True when the request's API key belongs to a user whose active access code includes `model`.
// Only called for a disabled model, so normal requests do not read the database an extra time.
function hasExclusiveAccess(req, model) {
  const apiKey = getClientApiKey(req);
  if (!apiKey || !apiKey.startsWith('sk-user-')) return false;
  const access = activeModelAccess(findUserByApiKey(apiKey));
  return Boolean(access && access.models.includes(stripModelPrefix(model).trim().toLowerCase()));
}

// ---------- Which balance pays for a request ----------
// Decided once, before anything is forwarded, in this order:
//   free       free mode or an active BANSOS window (unchanged behaviour, nothing is charged)
//   unlimited  an active unlimited pass that covers this model: no credits are charged
//   credits    token credits, when the model has a credit rate and the user has credits left
//   legacy     the old Rupiah balance / referral bonus tokens with the old per-1M prices
//              (kept separate from credits; can be switched off: billing legacy_rupiah off)
// A model without a credit rate ("menunggu konfigurasi") is never paid with credits.
function requestEffort(body) {
  const value = body?.reasoning_effort ?? body?.reasoning?.effort ?? '';
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function legacyFundsAvailable(user, config) {
  if (config && !config.billing.legacyRupiahEnabled) return false;
  const balance = Number(user.balance || 0);
  return (Number.isFinite(balance) && balance > 0) || Number(user.bonusTokens || 0) > 0;
}

function decideFunding(req, user) {
  if (isAllModelsFree()) return { funding: 'free', reason: 'free_mode' };
  if (req.bansos) return { funding: 'free', reason: 'bansos' };
  const model = req.displayModel || '';
  let config = null;
  let state = null;
  try {
    config = creditConfig.getCreditConfig();
    state = creditStore.getUserBillingState(user.telegramId, model);
  } catch (error) {
    if (isDbBusy(error)) throw error;
    console.error('[credits] unavailable, only the Rupiah balance is used:', error.message);
    config = null;
    state = null;
  }
  const legacy = legacyFundsAvailable(user, config);
  const credits = state ? state.account.available : 0;
  // Requests without a model (GET /v1/models, ...) are not billed; any balance lets them through.
  if (!model) return legacy || credits > 0 || state?.hasActivePass ? { funding: 'none' } : { reject: 'no_funds' };
  if (state?.pass) return { funding: 'unlimited', pass: state.pass };
  if (config && credits > 0) {
    const rate = creditRules.resolveRate(config, { model, provider: creditRules.providerOf(req.upstreamModel), effort: requestEffort(req.body) });
    if (rate.ok) return { funding: 'credits', snapshot: rate.snapshot, limits: config.limits, legacyFallback: legacy };
    if (legacy) return { funding: 'legacy', note: rate.reason };
    return { reject: 'pending_rate', reason: rate.reason, hasPass: Boolean(state?.hasActivePass) };
  }
  if (legacy) return { funding: 'legacy' };
  return { reject: 'no_funds', hasPass: Boolean(state?.hasActivePass) };
}

function rejectFunding(res, decision, model) {
  if (decision.reject === 'pending_rate') {
    return res.status(403).json({
      error: {
        message: `Model '${model}' cannot be used with token credits yet: ${decision.reason}. / Model ini belum bisa dipakai dengan kredit token (menunggu konfigurasi admin).`,
        type: 'model_pending_configuration',
        code: 'model_pending_configuration',
      },
    });
  }
  const outsidePass = decision.hasPass && model
    ? ` Model '${model}' is not included in your unlimited package, so it needs token credits. / Model ini tidak termasuk paket unlimited kamu, jadi memakai kredit token.`
    : '';
  return res.status(402).json({
    error: {
      message: `Insufficient balance. Buy a token credit package (or top up) before using the API.${outsidePass}`,
      type: 'insufficient_balance',
      code: 'payment_required',
    },
  });
}

// Every API request must use an active generated user key.
app.use('/v1', (req, res, next) => {
  const clientApiKey = getClientApiKey(req);
  if (!clientApiKey) return res.status(401).json({ error: { message: 'API key is required', type: 'missing_api_key' } });
  if (!clientApiKey.startsWith('sk-user-')) return res.status(401).json({ error: { message: 'Invalid user API key', type: 'invalid_api_key' } });
  const user = findUserByApiKey(clientApiKey);
  if (!user) return res.status(401).json({ error: { message: 'Invalid or revoked API key', type: 'invalid_api_key' } });
  req.userApiKey = clientApiKey;
  req.userRecord = user;
  // Extra models from an active model access code (used by GET /v1/models). Never blocks anything.
  req.modelAccess = activeModelAccess(user);
  // A model under an active BANSOS is free, also for users with no balance left.
  // Decided once here, so a request that started inside the window stays free.
  req.bansos = bansosFor(req.body && req.body.model);
  const decision = decideFunding(req, user);
  if (decision.reject) return rejectFunding(res, decision, req.displayModel);
  req.billing = decision;
  next();
});

// Per-user requests-per-minute limits set by the admin (bot: Admin Panel -> Rate Limit).
// Sliding 60s window kept in memory, so counters reset when the server restarts.
const RATE_WINDOW_MS = 60_000;
const rateLimitHits = new Map(); // "<user>|<rule key>" -> request timestamps (ms)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [bucket, hits] of rateLimitHits) {
    if (!hits.length || hits[hits.length - 1] <= cutoff) rateLimitHits.delete(bucket);
  }
}, 5 * 60_000).unref();

app.use('/v1', (req, res, next) => {
  const model = req.body && req.body.model;
  if (!model || !req.userRecord) return next();
  const displayName = stripModelPrefix(model);
  const rule = adminSettings.getRateLimitFor(displayName, getModelFamily(displayName));
  if (!rule) return next();
  const now = Date.now();
  const bucket = `${req.userRecord.telegramId || req.userApiKey}|${rule.key}`;
  const hits = (rateLimitHits.get(bucket) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (hits.length >= rule.rpm) {
    rateLimitHits.set(bucket, hits);
    const retryAfter = Math.max(1, Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    const target = rule.scope === 'model' ? `model '${displayName}'` : `the ${rule.name} family`;
    return res.status(429).json({
      error: {
        message: `Rate limit reached for ${target}: ${rule.rpm} requests per minute. Try again in ${retryAfter}s.`,
        type: 'rate_limit_exceeded',
        code: 'rate_limit_exceeded',
      },
    });
  }
  hits.push(now);
  rateLimitHits.set(bucket, hits);
  next();
});

// ---------- Recent prompts (bot: Admin Panel -> Recent Prompts) ----------
// Only while the admin has the feature ON, and only for generation requests that passed every
// check above (key, balance, model, rate limit). What is saved is the text of the LATEST user
// message: not the system prompt, the earlier history, tool results or images. It is written
// once the response is over, so recording never slows a request down or breaks one.
const PROMPT_ENDPOINTS = /^\/(chat\/completions|completions|responses|messages)\/?$/;

// Text parts of a message's content: a plain string, or OpenAI / Anthropic content parts.
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string' && (!part.type || /text/.test(String(part.type)))) return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function lastUserText(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || item.role !== 'user') continue;
    const text = contentText(item.content).trim();
    if (text) return text;
  }
  return '';
}

// chat/completions + Anthropic messages: `messages`; responses: `input`; completions: `prompt`.
function extractPromptText(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.messages)) return lastUserText(body.messages);
  if (typeof body.input === 'string') return body.input.trim();
  if (Array.isArray(body.input)) return lastUserText(body.input);
  if (typeof body.prompt === 'string') return body.prompt.trim();
  if (Array.isArray(body.prompt)) return body.prompt.filter((part) => typeof part === 'string').join('\n').trim();
  return '';
}

app.use('/v1', (req, res, next) => {
  if (req.method !== 'POST' || !req.userRecord || !PROMPT_ENDPOINTS.test(req.path)) return next();
  // Tolerates outdated usage-db.js / admin-settings.js uploads: no recording, requests unaffected.
  if (typeof usageDb.recordPrompt !== 'function' || typeof adminSettings.isPromptLogEnabled !== 'function') return next();
  try {
    if (!adminSettings.isPromptLogEnabled()) return next();
    const text = extractPromptText(req.body);
    if (text) {
      const telegramId = req.userRecord.telegramId;
      const model = stripModelPrefix(req.body.model || '');
      const endpoint = `${req.baseUrl}${req.path}`;
      res.once('close', () => {
        runDbWrite(`prompt log user ${telegramId}`, () => usageDb.recordPrompt(telegramId, { text, model, endpoint, status: res.statusCode }));
      });
    }
  } catch (error) {
    console.error('[prompts] skipped:', error.message);
  }
  return next();
});

// ---------- AI moderation (bot: Admin Panel -> Moderation) ----------
// Generation requests for a moderated family (ChatGPT by default) are checked by our own upstream
// model first: cyber abuse / ToS violations are rejected with HTTP 400 and never reach the model,
// so they are not billed. Analysed: the latest user message plus the client's system/developer
// instructions. Fail-open: when the checker fails the request goes through (see moderation.js).
function extractInstructions(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  if (typeof body.system === 'string' || Array.isArray(body.system)) parts.push(contentText(body.system)); // Anthropic
  if (typeof body.instructions === 'string') parts.push(body.instructions); // Responses API
  const items = Array.isArray(body.messages) ? body.messages : (Array.isArray(body.input) ? body.input : []);
  for (const item of items) {
    if (item && (item.role === 'system' || item.role === 'developer')) parts.push(contentText(item.content));
  }
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
}

app.use('/v1', async (req, res, next) => {
  if (req.method !== 'POST' || !req.userRecord || !PROMPT_ENDPOINTS.test(req.path)) return next();
  let settings;
  let userText = '';
  try {
    settings = moderation.moderationFor(req.body && req.body.model);
    if (settings) userText = extractPromptText(req.body);
  } catch (error) {
    console.error('[moderation] skipped:', error.message);
    return next();
  }
  if (!settings || !userText) return next();

  const model = stripModelPrefix(req.body.model);
  const endpoint = `${req.baseUrl}${req.path}`;
  const result = await moderation.checkPrompt(
    { userText, instructions: extractInstructions(req.body) },
    settings,
    { baseUrl: UPSTREAM_BASE_URL, apiKey: API_KEY },
  );
  // The client may have hung up while the prompt was being checked.
  if (res.headersSent || res.destroyed) return undefined;
  if (result.verdict === 'error') {
    console.error(`[moderation] check failed, request allowed (fail-open): user ${req.userRecord.telegramId} ${model}: ${result.error}`);
    return next();
  }
  if (result.verdict !== 'block') return next();

  console.warn(`[moderation] BLOCKED user ${req.userRecord.telegramId} ${model} [${result.category}]${result.cached ? ' (cached)' : ''}: ${result.reason}`);
  if (!result.cached) {
    moderation.reportBlock({ user: req.userRecord, model, endpoint, verdict: result, text: userText, settings });
  }
  // OpenAI clients read error.message/code; Anthropic clients read type + error.type.
  return res.status(400).json({
    type: 'error',
    error: {
      message: `Request rejected by content moderation: this prompt appears to violate the usage policy (${result.category}). Please rephrase your request, or contact support if you think this is a mistake.`,
      type: 'invalid_request_error',
      code: 'content_policy_violation',
      param: null,
    },
  });
});

function resolveUpstreamModel(model) {
  const requested = String(model || '');
  try {
    const cache = JSON.parse(fs.readFileSync(modelCachePath, 'utf8'));
    if (cache.aliases?.[requested]) return cache.aliases[requested];
  } catch (_) {
    // The model cache is optional; use the default upstream provider prefix below.
  }
  if (!requested.includes('/')) return `1/${requested}`;
  return requested;
}

// Return a normalized model list so clients see `gpt-6-astra`, not `1/gpt-6-astra`.
// Disabled models are left out, except the ones the caller's active model access code unlocks.
app.get('/v1/models', async (req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    });
    const payload = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(payload);
    const unlocked = new Set(req.modelAccess?.models || []);
    const hidden = (displayName) => adminSettings.isModelDisabled(displayName, getModelFamily(displayName))
      && !unlocked.has(displayName.toLowerCase());
    const byDisplayName = new Map();
    for (const model of payload.data || []) {
      if (!model.id) continue;
      const displayName = stripModelPrefix(model.id);
      if (hidden(displayName)) continue;
      if (!byDisplayName.has(displayName) || model.id.startsWith('1/')) {
        byDisplayName.set(displayName, { ...model, id: displayName });
      }
    }
    // Keep pinned models listed when the upstream response leaves them out.
    for (const displayName of Object.keys(PINNED_MODELS)) {
      if (byDisplayName.has(displayName)) continue;
      if (hidden(displayName)) continue;
      byDisplayName.set(displayName, { id: displayName, object: 'model', owned_by: (getModelFamily(displayName) || 'deepseek').toLowerCase() });
    }
    return res.json({ ...payload, data: [...byDisplayName.values()] });
  } catch (error) {
    return res.status(502).json({ error: { message: 'Could not load upstream models', detail: error.message } });
  }
});

// ---------- Token usage for billing ----------
// Billing uses the token counts the upstream reports. Three gaps are closed here:
//  1. Streaming chat/completions only report usage when the request asks for it, so the proxy adds
//     stream_options.include_usage. The client then also receives the standard final chunk with
//     `"choices": []` and the usage. FORCE_STREAM_USAGE=false turns this off.
//  2. A compressed upstream response (gzip / deflate / br) is decompressed for reading only; the
//     client still receives the bytes unchanged.
//  3. Usage is read from OpenAI chat/completions, Responses API (response.completed) and Anthropic
//     messages (message_start + message_delta) streams. When a successful generation response still
//     has no usage at all, the tokens are estimated from the text (about 4 characters per token,
//     1 per CJK character) and the request is billed with `estimated: true` in the logs.
const FORCE_STREAM_USAGE = String(process.env.FORCE_STREAM_USAGE ?? 'true').trim().toLowerCase() !== 'false';
const STREAM_USAGE_PATH = /^\/v1\/(chat\/completions|completions)\/?$/;
const GENERATION_PATH = /^\/v1\/(chat\/completions|completions|responses|messages)\/?$/;
const WIDE_CHARACTERS = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

function requestPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

// Asks the upstream for usage on a streaming chat/completions request. True when it was added.
function requestStreamUsage(req) {
  if (!FORCE_STREAM_USAGE || req.method !== 'POST' || !req.body || req.body.stream !== true) return false;
  if (!STREAM_USAGE_PATH.test(requestPath(req))) return false;
  const current = req.body.stream_options;
  const options = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  if (options.include_usage === true) return false;
  req.body.stream_options = { ...options, include_usage: true };
  return true;
}

// The response body as text, decompressed when the upstream compressed it. A body cut off midway
// (client hung up) is decoded as far as it goes.
function responseText(buffer, contentEncoding) {
  let data = buffer;
  const encodings = String(contentEncoding || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean).reverse();
  for (const encoding of encodings) {
    if (encoding === 'identity') continue;
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      data = zlib.gunzipSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } else if (encoding === 'deflate') {
      try {
        data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (_) {
        data = zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      }
    } else if (encoding === 'br') {
      data = zlib.brotliDecompressSync(data, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    } else {
      throw new Error(`unsupported content-encoding "${encoding}"`);
    }
  }
  return data.toString('utf8');
}

// Text of a message content: a string, or OpenAI / Anthropic content parts (tool results nested).
function partsText(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || depth > 4) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (part.content !== undefined) return partsText(part.content, depth + 1);
    if (part.type === 'tool_use' && part.input) return JSON.stringify(part.input);
    return '';
  }).filter(Boolean).join('\n');
}

// Everything in the request that the model reads as text (images are not counted).
function requestTextForEstimate(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [partsText(body.system)];
  if (typeof body.instructions === 'string') parts.push(body.instructions);
  const items = [...(Array.isArray(body.messages) ? body.messages : []), ...(Array.isArray(body.input) ? body.input : [])];
  for (const item of items) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    parts.push(partsText(item.content));
    for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) parts.push(String(call?.function?.arguments || ''));
    if (typeof item.output === 'string') parts.push(item.output);
    if (typeof item.arguments === 'string') parts.push(item.arguments);
  }
  if (typeof body.input === 'string') parts.push(body.input);
  if (typeof body.prompt === 'string') parts.push(body.prompt);
  if (Array.isArray(body.prompt)) parts.push(body.prompt.filter((value) => typeof value === 'string').join('\n'));
  if (Array.isArray(body.tools) && body.tools.length) parts.push(JSON.stringify(body.tools));
  return parts.filter(Boolean).join('\n');
}

// Generated text in one response object or stream event (deltas only, so nothing is counted twice).
function generatedText(event) {
  if (!event || typeof event !== 'object') return '';
  const parts = [];
  for (const choice of Array.isArray(event.choices) ? event.choices : []) {
    const message = choice?.delta || choice?.message || {};
    parts.push(partsText(message.content));
    if (typeof message.reasoning_content === 'string') parts.push(message.reasoning_content);
    if (typeof message.reasoning === 'string') parts.push(message.reasoning);
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) parts.push(String(call?.function?.arguments || ''));
    if (typeof choice?.text === 'string') parts.push(choice.text);
  }
  // Responses API stream: response.output_text.delta, response.function_call_arguments.delta, ...
  if (typeof event.type === 'string' && event.type.endsWith('.delta') && typeof event.delta === 'string') parts.push(event.delta);
  // Anthropic stream.
  if (event.type === 'content_block_delta' && event.delta) {
    parts.push(String(event.delta.text || event.delta.partial_json || event.delta.thinking || ''));
  }
  // Non-streaming Responses API and Anthropic messages.
  for (const item of Array.isArray(event.output) ? event.output : []) {
    parts.push(partsText(item?.content));
    if (typeof item?.arguments === 'string') parts.push(item.arguments);
  }
  if (event.type === 'message' && Array.isArray(event.content)) parts.push(partsText(event.content));
  return parts.filter(Boolean).join('');
}

function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const wide = (value.match(WIDE_CHARACTERS) || []).length;
  return Math.ceil((value.length - wide) / 4) + wide;
}

// Reads a whole response (JSON or SSE). Every usage object is normalised by credit-rules.js
// (OpenAI, Responses API, DeepSeek, Anthropic incl. cache tokens, Gemini usageMetadata;
// reasoning and cached tokens counted exactly once). Counts are cumulative in every format we
// know, so the highest value of each field wins: that also joins Anthropic's input
// (message_start) and output (message_delta) counts.
// { found, counts, inputTokens, outputTokens, model, outputText }.
function readUsage(text) {
  const result = { found: false, counts: null, inputTokens: 0, outputTokens: 0, model: '', outputText: '' };
  const pieces = [];
  const take = (event) => {
    if (!event || typeof event !== 'object') return;
    for (const usage of [event.usage, event.response?.usage, event.message?.usage, event.usageMetadata]) {
      const counts = creditRules.normalizeUsage(usage);
      if (!counts) continue;
      result.found = true;
      result.counts = creditRules.mergeUsage(result.counts, counts);
    }
    const model = event.model || event.response?.model || event.message?.model;
    if (typeof model === 'string' && model) result.model = model;
    pieces.push(generatedText(event));
  };
  let whole;
  try {
    whole = JSON.parse(text);
  } catch (_) {
    whole = undefined;
  }
  if (whole !== undefined) {
    take(whole);
  } else {
    // Streaming responses contain one JSON object per SSE data line.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        take(JSON.parse(data));
      } catch (_) { /* Ignore non-JSON keep-alive chunks. */ }
    }
  }
  result.inputTokens = result.counts?.inputTokens || 0;
  result.outputTokens = result.counts?.outputTokens || 0;
  result.outputText = pieces.join('');
  return result;
}

// ---------- Token credits: reservation before, settlement after ----------
// Before a credit-paid request is forwarded, credits are reserved atomically (credit-store.js)
// for the estimated input (text length, plus inputSafetyPercent) and the output limit. When the
// balance cannot pay for the requested output, the output limit is lowered to what it can pay
// for (header X-Credit-Output-Limit); when it cannot pay for even minOutputTokens the request is
// refused with 402. After the response the reservation is settled ONCE with the usage the
// upstream reported, at the rate snapshot taken at the start, and the rest is released.
// Policy when usage is missing (README "Kredit token"): a successful response without usage, or
// a stream that was cut off, is billed from the text (about 4 characters per token, never 0 for
// a real generation) and marked estimated; an upstream error without usage, or an upstream that
// never answered, costs nothing; a client that hung up before the upstream answered pays the
// input estimate (the prompt was already sent upstream).
function outputLimitField(urlPath, body, limits) {
  if (/\/responses\/?$/.test(urlPath)) return 'max_output_tokens';
  if (/\/messages\/?$/.test(urlPath)) return 'max_tokens';
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null) return 'max_completion_tokens';
  if (body.max_tokens !== undefined && body.max_tokens !== null) return 'max_tokens';
  return /\/chat\/completions\/?$/.test(urlPath) ? limits.chatMaxTokensField : 'max_tokens';
}

function clientOutputLimit(body, field) {
  const value = Number(body?.[field]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function reserveForRequest(req, res, plan) {
  const { snapshot, limits } = plan;
  const urlPath = requestPath(req);
  const generation = req.method === 'POST' && GENERATION_PATH.test(urlPath) && req.body && typeof req.body === 'object';
  const rawInput = estimateTokens(requestTextForEstimate(req.body));
  const inputEstimate = Math.ceil((rawInput * (100 + limits.inputSafetyPercent)) / 100);
  const field = generation ? outputLimitField(urlPath, req.body, limits) : null;
  const requested = field ? clientOutputLimit(req.body, field) : null;
  const toolReserve = snapshot.toolCallCredits ? snapshot.toolCallCredits * limits.toolCallReserve : 0;
  const result = creditStore.reserveCredits(req.userRecord.telegramId, (available) => {
    const minOutput = generation ? Math.min(limits.minOutputTokens, requested || limits.minOutputTokens) : 0;
    const minimum = creditRules.computeCredits(snapshot.units, { inputTokens: inputEstimate, outputTokens: minOutput }) + toolReserve;
    if (available < minimum) return { reject: true, needed: minimum };
    const inputCost = creditRules.computeCredits(snapshot.units, { inputTokens: inputEstimate });
    const affordable = generation ? creditRules.affordableOutputTokens(snapshot.units, available - inputCost - toolReserve) : 0;
    const wanted = generation ? (requested || limits.defaultReserveOutputTokens) : 0;
    const reserveOutput = Math.max(0, Math.min(wanted, affordable));
    let setLimit = null;
    if (generation && ((requested && requested > affordable) || (!requested && affordable < limits.defaultReserveOutputTokens))) setLimit = reserveOutput;
    return {
      credits: creditRules.computeCredits(snapshot.units, { inputTokens: inputEstimate, outputTokens: reserveOutput }) + toolReserve,
      setLimit,
      estimate: { inputTokens: rawInput, inputReserved: inputEstimate, outputReserved: reserveOutput },
    };
  }, { snapshot, endpoint: urlPath });
  if (!result.ok) return result;
  if (result.plan.setLimit !== null && field && result.plan.setLimit > 0) {
    req.body[field] = result.plan.setLimit;
    res.setHeader('X-Credit-Output-Limit', String(result.plan.setLimit));
  }
  req.creditReservation = result.reservation;
  req.creditInputEstimate = rawInput;
  res.setHeader('X-Billing-Funding', 'credits');
  res.setHeader('X-Credit-Multiplier', snapshot.multiplier);
  res.setHeader('X-Credit-Reserved', String(result.reservation.credits));
  return result;
}

// Unlimited pass limits, per user, in memory (like the RPM limits; reset on restart).
const unlimitedInFlight = new Map(); // telegramId -> running requests
const unlimitedHits = new Map(); // telegramId -> request timestamps (ms)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of unlimitedHits) if (!hits.length || hits[hits.length - 1] <= cutoff) unlimitedHits.delete(id);
}, 5 * 60_000).unref();

function enforceUnlimited(req, res, pass) {
  const id = String(req.userRecord.telegramId);
  const limits = pass.limits || {};
  const now = Date.now();
  const hits = (unlimitedHits.get(id) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (limits.rpm && hits.length >= limits.rpm) {
    const retryAfter = Math.max(1, Math.ceil((hits[0] + RATE_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: { message: `Unlimited package limit: ${limits.rpm} requests per minute. Try again in ${retryAfter}s. / Batas paket unlimited tercapai.`, type: 'unlimited_rate_limit', code: 'rate_limit_exceeded' } });
    return false;
  }
  const running = unlimitedInFlight.get(id) || 0;
  if (limits.maxConcurrent && running >= limits.maxConcurrent) {
    res.set('Retry-After', '5');
    res.status(429).json({ error: { message: `Unlimited package limit: at most ${limits.maxConcurrent} requests at the same time. / Batas request bersamaan paket unlimited tercapai.`, type: 'unlimited_concurrency_limit', code: 'rate_limit_exceeded' } });
    return false;
  }
  hits.push(now);
  unlimitedHits.set(id, hits);
  unlimitedInFlight.set(id, running + 1);
  res.once('close', () => {
    const left = (unlimitedInFlight.get(id) || 1) - 1;
    if (left > 0) unlimitedInFlight.set(id, left);
    else unlimitedInFlight.delete(id);
  });
  const urlPath = requestPath(req);
  if (limits.maxOutputTokens && req.method === 'POST' && GENERATION_PATH.test(urlPath) && req.body && typeof req.body === 'object') {
    const field = outputLimitField(urlPath, req.body, creditConfig.getCreditConfig().limits);
    const current = clientOutputLimit(req.body, field);
    if (!current || current > limits.maxOutputTokens) {
      req.body[field] = limits.maxOutputTokens;
      res.setHeader('X-Unlimited-Output-Limit', String(limits.maxOutputTokens));
    }
  }
  res.setHeader('X-Billing-Funding', 'unlimited');
  return true;
}

app.use('/v1', (req, res, next) => {
  const plan = req.billing;
  if (!plan || !req.userRecord) return next();
  if (plan.funding === 'unlimited') return enforceUnlimited(req, res, plan.pass) ? next() : undefined;
  if (plan.funding !== 'credits') return next();
  const reserved = reserveForRequest(req, res, plan);
  if (reserved.ok) {
    // Safety net: a request that never reached the upstream gives its reservation back.
    res.once('close', () => {
      if (!req.creditForwarded) finalizeWithoutResponse(req, 'not_forwarded');
    });
    return next();
  }
  if (plan.legacyFallback) {
    req.billing = { funding: 'legacy', note: 'credits_insufficient' };
    return next();
  }
  return res.status(402).json({
    error: {
      message: `Insufficient token credits for '${req.displayModel}' (x${plan.snapshot.multiplier}): ${reserved.available} credits available, this request needs at least ${reserved.needed}. / Kredit token tidak cukup untuk request ini; beli paket kredit di bot.`,
      type: 'insufficient_credits',
      code: 'payment_required',
      available_credits: reserved.available,
      required_credits: reserved.needed,
      multiplier: plan.snapshot.multiplier,
    },
  });
});

const EMPTY_COUNTS = Object.freeze({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolCalls: 0 });

function inputEstimateOf(req) {
  if (req.creditInputEstimate === undefined) req.creditInputEstimate = estimateTokens(requestTextForEstimate(req.body));
  return req.creditInputEstimate;
}

// The upstream never sent a response (connection error, timeout) or the client hung up first.
function finalizeWithoutResponse(req, reason) {
  if (req.billingFinalized || req.upstreamResponded) return;
  req.billingFinalized = true;
  const reservation = req.creditReservation;
  if (!reservation) return;
  const clientGone = reason === 'client_aborted' && req.creditForwarded;
  if (clientGone) {
    runDbWrite(`credit settle ${reservation.id}`, () => creditStore.settleReservation(reservation.id, {
      counts: { inputTokens: inputEstimateOf(req) }, estimated: true, status: 499, reason: 'client_aborted_before_response',
    }));
  } else {
    runDbWrite(`credit release ${reservation.id}`, () => creditStore.releaseReservation(reservation.id, reason));
  }
}

// Usage of one finished (or cut off) upstream response, billed to whatever pays for the request.
function finalizeUsage(req, proxyRes, chunks, complete) {
  if (req.billingFinalized) return;
  req.billingFinalized = true;
  let parsed = { found: false, counts: null, model: '', outputText: '' };
  let readable = true;
  try {
    parsed = readUsage(responseText(Buffer.concat(chunks), proxyRes.headers['content-encoding']));
  } catch (error) {
    // Undecodable bodies are still counted as requests (and estimated below when successful).
    readable = false;
    console.error(`[billing] could not read the response of ${req.originalUrl}: ${error.message}`);
  }
  const status = proxyRes.statusCode;
  const plan = req.billing || { funding: 'legacy' };
  const reported = parsed.found ? parsed.counts : null;
  const hasTokens = Boolean(reported && reported.inputTokens + reported.outputTokens > 0);
  const generation = req.method === 'POST' && GENERATION_PATH.test(requestPath(req));
  const billable = status < 400 && (generation || Boolean(req.creditReservation));
  let counts = reported ? { ...reported } : { ...EMPTY_COUNTS };
  let estimated = false;
  if (billable && !hasTokens) {
    // A successful generation without any reported tokens would otherwise be free.
    counts = { ...EMPTY_COUNTS, inputTokens: inputEstimateOf(req), outputTokens: estimateTokens(parsed.outputText) };
    estimated = true;
  } else if (billable && !complete) {
    // Cut off: what was reported may predate the cut (Anthropic reports output 1 at the start).
    const seenOutput = estimateTokens(parsed.outputText);
    if (seenOutput > counts.outputTokens) {
      counts.outputTokens = seenOutput;
      estimated = true;
    }
    if (!counts.inputTokens) {
      counts.inputTokens = inputEstimateOf(req);
      estimated = true;
    }
  }
  const partial = !complete;
  const billingModel = parsed.model || req.requestModel;
  if (estimated) {
    console.warn(`[billing] ${partial ? 'response cut off' : 'no usage from upstream'} for ${req.originalUrl} (${billingModel}, user ${req.userRecord?.telegramId || '-'}${readable ? '' : ', unreadable body'}): billed an estimate of ${counts.inputTokens} + ${counts.outputTokens} tokens`);
  }
  const totalTokens = counts.inputTokens + counts.outputTokens;
  req.usageDetails = { inputTokens: counts.inputTokens, outputTokens: counts.outputTokens, totalTokens, pricePerMillion: 0, cost: 0, ...(estimated ? { estimated: true } : {}) };
  const base = {
    endpoint: req.originalUrl,
    statusCode: status,
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    ...(estimated ? { estimated: true } : {}),
  };
  const logUsage = (extra) => runDbWrite(`usage log user ${req.userRecord?.telegramId || '-'}`, () => recordUsage(req.userApiKey, { ...base, ...extra }));

  if (plan.funding === 'credits' && req.creditReservation) {
    const reservation = req.creditReservation;
    if (status >= 400 && !hasTokens) {
      // Failed before any usage: nothing is charged, the whole reservation is released.
      runDbWrite(`credit release ${reservation.id}`, () => creditStore.releaseReservation(reservation.id, `upstream status ${status}`));
      req.usageDetails.credits = 0;
      req.usageDetails.multiplier = reservation.snapshot.multiplier;
      logUsage({ model: req.requestModel, pricePerMillion: 0, funding: 'credits', credits: 0, multiplier: reservation.snapshot.multiplier, rateModel: reservation.snapshot.rateModel });
      return;
    }
    runDbWrite(`credit settle ${reservation.id}`, () => creditStore.settleReservation(reservation.id, {
      counts, estimated, partial, status, upstreamModel: parsed.model,
    }), (settled) => {
      if (!settled || !settled.ok) return;
      req.usageDetails.credits = settled.charged;
      req.usageDetails.multiplier = settled.multiplier;
      if (settled.shortfall) console.warn(`[credits] user ${reservation.userId}: ${settled.shortfall} credits could not be collected (balance exhausted) on ${reservation.id}`);
      logUsage({
        model: req.requestModel,
        pricePerMillion: 0,
        funding: 'credits',
        credits: settled.charged,
        multiplier: settled.multiplier,
        rateModel: settled.rateModel,
        cachedInputTokens: counts.cachedInputTokens,
        partial,
        shortfall: settled.shortfall,
      });
    });
    return;
  }
  if (plan.funding === 'unlimited' || plan.funding === 'free') {
    logUsage({ model: billingModel, pricePerMillion: 0, funding: plan.funding });
    return;
  }
  // Old Rupiah balance (and requests without a model). BANSOS requests cost Rp0.
  const pricePerMillion = req.bansos ? 0 : require('./pricing').getBillingPrice(billingModel);
  const cost = pricePerMillion ? (totalTokens / 1_000_000) * pricePerMillion : 0;
  Object.assign(req.usageDetails, { pricePerMillion, cost });
  runDbWrite(`usage billing user ${req.userRecord?.telegramId || '-'}`, () => recordUsage(req.userApiKey, {
    ...base,
    model: billingModel,
    ...(req.bansos ? { pricePerMillion: 0 } : {}),
    ...(plan.funding === 'legacy' ? { funding: 'legacy' } : {}),
  }), (recorded) => {
    // Bonus tokens may have covered part of the bill: log what was really charged.
    if (recorded && typeof recorded === 'object') {
      req.usageDetails.cost = recorded.cost;
      req.usageDetails.balanceAfter = recorded.balance;
    }
  });
}

// OpenAI-compatible endpoint:
//   client baseURL: http://127.0.0.1:8080/v1
//   request:        POST /v1/chat/completions
//   upstream:       POST <UPSTREAM_BASE_URL>/chat/completions
app.use(
  '/v1',
  createProxyMiddleware({
    target: UPSTREAM_BASE_URL,
    changeOrigin: true,
    // UPSTREAM_BASE_URL already includes the /v1 segment, so strip our
    // local /v1 mount prefix before appending the remainder to the target.
    pathRewrite: { '^/v1': '' },
    logger: console,
    on: {
      proxyReq: (proxyReq, req) => {
        const userApiKey = req.userApiKey || getClientApiKey(req);
        req.userApiKey = userApiKey;

        // Use the configured upstream key when available. This lets OpenAI SDK
        // clients use any local placeholder key while the proxy authenticates
        // with the real upstream credential.
        if (API_KEY) {
          proxyReq.setHeader('Authorization', `Bearer ${API_KEY}`);
        }
        req.requestModel = stripModelPrefix(req.body?.model || '');
        // Must happen before fixRequestBody, which writes req.body to the upstream.
        req.streamUsageRequested = requestStreamUsage(req);

        if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
          fixRequestBody(proxyReq, req);
        }
        req.creditForwarded = true;
        proxyReq.once('response', () => {
          req.upstreamResponded = true;
        });
        // Closed without any response: an upstream failure, or the client hung up first.
        proxyReq.once('close', () => {
          if (!req.upstreamResponded) finalizeWithoutResponse(req, req.socket?.destroyed ? 'client_aborted' : 'connection_closed');
        });

        console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${UPSTREAM_BASE_URL}${req.url}`);
      },
      proxyRes: (proxyRes, req, res) => {
        req.upstreamResponded = true;
        if (!req.userApiKey) return;
        const chunks = [];
        let ended = false;
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.once('end', () => {
          ended = true;
          finalizeUsage(req, proxyRes, chunks, true);
        });
        // A stream cut off midway ('close' without 'end'): bill what really happened, and close the
        // client's connection too (the pipe would otherwise leave it waiting for more data forever).
        proxyRes.once('close', () => {
          if (ended) return;
          finalizeUsage(req, proxyRes, chunks, false);
          if (res && !res.writableEnded && !res.destroyed) res.destroy();
        });
      },
      error: (err, req, res) => {
        console.error('[proxy] error:', err.message);
        finalizeWithoutResponse(req, 'upstream_error');
        if (res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'Upstream proxy error', type: 'proxy_error' },
          }));
        }
      },
    },
  })
);

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    upstream: UPSTREAM_BASE_URL,
    authentication: API_KEY ? 'configured' : 'caller-provided',
  });
});

// A busy database inside a route (e.g. the Cashi webhook): answer 503 + Retry-After so the
// caller retries, instead of Express's default HTML 500. Other errors keep the default handler.
app.use((error, req, res, next) => {
  if (!isDbBusy(error) || res.headersSent) return next(error);
  console.error(`[db] ${req.method} ${req.originalUrl}:`, error.message);
  res.set('Retry-After', '1');
  return res.status(503).json({ error: { message: error.message, type: 'database_busy' } });
});

app.listen(PORT, HOST, () => {
  console.log(`OpenAI-compatible API proxy listening on http://${HOST}:${PORT}`);
  // Internal addresses of this container/host, for DATA_API_URL on a bot running on the same node.
  const internal = Object.values(require('os').networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${PORT}`);
  if (internal.length) console.log(`[internal] Bot DATA_API_URL candidates: ${internal.join(' , ')}`);
  const missing = Object.keys(INTERNAL_FUNCTIONS).filter((name) => typeof INTERNAL_FUNCTIONS[name] !== 'function');
  if (missing.length) console.error(`[internal] Outdated files: missing ${missing.join(', ')}. Upload the latest usage-db.js, admin-settings.js, credit-rules.js, credit-config.js and credit-store.js.`);
  console.log(`Forwarding /v1/* -> ${UPSTREAM_BASE_URL}/*`);
  // Credit reservations left behind by a previous process (crash / restart) or older than the TTL.
  const sweepCredits = () => {
    try {
      creditStore.sweepReservations();
    } catch (error) {
      console.error('[credits] reservation sweep failed:', error.message);
    }
  };
  sweepCredits();
  setInterval(sweepCredits, 10 * 60_000).unref();
  try {
    const credits = creditConfig.getCreditConfig();
    console.log(`[credits] token credits ready: config v${credits.version}, ${credits.packages.filter((item) => item.active).length} package(s) on sale, state ${path.basename(creditStore.statePath)}`);
  } catch (error) {
    console.error('[credits] configuration problem:', error.message);
  }
});

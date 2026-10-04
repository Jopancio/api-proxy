require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { findUserByApiKey, recordAdminRequest, recordUsage, settleOrder } = require('./usage-db');
const usageDb = require('./usage-db');
const adminSettings = require('./admin-settings');
const { PINNED_MODELS, getModelFamily, stripModelPrefix } = require('./pricing');
const { isAllModelsFree } = require('./admin-settings');
const moderation = require('./moderation');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
// Support both the project-specific name and the name used by OpenAI clients.
const API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
const CASHI_SECRET_KEY = process.env.CASHI_SECRET_KEY;
const modelCachePath = path.join(__dirname, 'data', 'models.json');

if (!UPSTREAM_BASE_URL) {
  console.error('UPSTREAM_BASE_URL is not set. Refusing to start.');
  process.exit(1);
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
  if (event.event === 'PAYMENT_SETTLED' && event.data?.status === 'SETTLED') {
    settleOrder(event.data.order_id, event.data.amount);
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
    recordAdminRequest({
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
    });
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
  if (model && adminSettings.isModelDisabled(model, getModelFamily(model))) {
    return res.status(403).json({
      error: {
        message: `Model '${model}' is currently disabled by the admin. Please choose another model.`,
        type: 'model_disabled',
      },
    });
  }
  if (model && req.body) req.body.model = resolveUpstreamModel(model);
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
// the user's keys may ONLY use that code's models. Worked out from the clock on every request, so
// the user's normal model access comes back by itself when the period ends. Null = no limit now.
// Tolerates a usage-db.js uploaded before access codes existed: nobody is restricted then.
function activeModelAccess(user) {
  if (typeof usageDb.modelAccessFor !== 'function') return null;
  const access = usageDb.modelAccessFor(user);
  return access && access.restricted && Array.isArray(access.allowedModels) ? access : null;
}

// The error body for a request the active access code does not allow, or null when it is allowed.
function modelAccessViolation(req, access) {
  const model = req.body && req.body.model;
  const allowed = access.allowedModels.join(', ');
  const until = access.restrictedUntil;
  if (typeof model === 'string' && model.trim()) {
    const displayName = stripModelPrefix(model).trim();
    if (access.allowedModels.includes(displayName.toLowerCase())) return null;
    return {
      error: {
        message: `Model '${displayName}' is not included in your model access code. Until ${until} this API key can only use: ${allowed}.`,
        type: 'model_not_allowed',
        code: 'model_access_restricted',
      },
    };
  }
  // Reading (e.g. GET /v1/models) is fine. A write without a JSON "model" cannot be checked, so
  // it would let the upstream pick a model: refuse it while the restriction is on.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  return {
    error: {
      message: `Your model access code is active until ${until}: set "model" to one of: ${allowed}.`,
      type: 'model_required',
      code: 'model_access_restricted',
    },
  };
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
  // Checked before the balance, so a restricted user is told which models they may use.
  const access = activeModelAccess(user);
  if (access) {
    req.modelAccess = access;
    const violation = modelAccessViolation(req, access);
    if (violation) return res.status(403).json(violation);
  }
  const balance = Number(user.balance || 0);
  // Referral bonus tokens also let a user call the API with a zero Rp balance.
  const bonusTokens = Number(user.bonusTokens || 0);
  // A model under an active BANSOS is free, also for users with no balance left.
  // Decided once here, so a request that started inside the window stays free.
  req.bansos = bansosFor(req.body && req.body.model);
  if (!isAllModelsFree() && !req.bansos && (!Number.isFinite(balance) || balance <= 0) && !(bonusTokens > 0)) {
    return res.status(402).json({
      error: {
        message: 'Insufficient balance. Please top up your account before using the API.',
        type: 'insufficient_balance',
        code: 'payment_required',
      },
    });
  }
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
        try {
          usageDb.recordPrompt(telegramId, { text, model, endpoint, status: res.statusCode });
        } catch (error) {
          console.error('[prompts] could not save:', error.message);
        }
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
// While the caller's model access code is active, only that code's models are listed.
app.get('/v1/models', async (req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    });
    const payload = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(payload);
    const byDisplayName = new Map();
    for (const model of payload.data || []) {
      if (!model.id) continue;
      const displayName = stripModelPrefix(model.id);
      if (adminSettings.isModelDisabled(displayName, getModelFamily(displayName))) continue;
      if (!byDisplayName.has(displayName) || model.id.startsWith('1/')) {
        byDisplayName.set(displayName, { ...model, id: displayName });
      }
    }
    // Keep pinned models listed when the upstream response leaves them out.
    for (const displayName of Object.keys(PINNED_MODELS)) {
      if (byDisplayName.has(displayName)) continue;
      if (adminSettings.isModelDisabled(displayName, getModelFamily(displayName))) continue;
      byDisplayName.set(displayName, { id: displayName, object: 'model', owned_by: (getModelFamily(displayName) || 'deepseek').toLowerCase() });
    }
    const allowed = req.modelAccess?.allowedModels;
    const data = [...byDisplayName.values()].filter((model) => !allowed || allowed.includes(String(model.id).toLowerCase()));
    return res.json({ ...payload, data });
  } catch (error) {
    return res.status(502).json({ error: { message: 'Could not load upstream models', detail: error.message } });
  }
});

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

        if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
          fixRequestBody(proxyReq, req);
        }

        console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${UPSTREAM_BASE_URL}${req.url}`);
      },
      proxyRes: (proxyRes, req) => {
        if (!req.userApiKey) return;
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let usage = {};
          let model = '';
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const parsed = JSON.parse(body);
              usage = parsed.usage || {};
              model = parsed.model || '';
            } catch (_) {
              // Streaming responses contain one JSON object per SSE data line.
              for (const line of body.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                try {
                  const parsed = JSON.parse(line.slice(5).trim());
                  if (parsed.usage) usage = parsed.usage;
                  if (parsed.model) model = parsed.model;
                } catch (_) { /* Ignore non-JSON keep-alive chunks. */ }
              }
            }
          } catch (_) {
            // Streaming responses and non-JSON errors are still counted as requests.
          }
          const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
          const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
          const billingModel = model || req.requestModel;
          // BANSOS requests cost Rp0, so neither the balance nor bonus tokens are used.
          const pricePerMillion = req.bansos ? 0 : require('./pricing').getBillingPrice(billingModel);
          const totalTokens = Number(inputTokens) + Number(outputTokens);
          const cost = pricePerMillion ? (totalTokens / 1_000_000) * pricePerMillion : 0;
          req.usageDetails = { inputTokens, outputTokens, totalTokens, pricePerMillion, cost };
          const recorded = recordUsage(req.userApiKey, {
            endpoint: req.originalUrl,
            statusCode: proxyRes.statusCode,
            model: billingModel,
            inputTokens,
            outputTokens,
            ...(req.bansos ? { pricePerMillion: 0 } : {}),
          });
          // Bonus tokens may have covered part of the bill: log what was really charged.
          if (recorded && typeof recorded === 'object') req.usageDetails.cost = recorded.cost;
          const updatedUser = require('./usage-db').findUserByApiKey(req.userApiKey);
          req.usageDetails.balanceAfter = updatedUser?.balance;
        });
      },
      error: (err, req, res) => {
        console.error('[proxy] error:', err.message);
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

app.listen(PORT, HOST, () => {
  console.log(`OpenAI-compatible API proxy listening on http://${HOST}:${PORT}`);
  // Internal addresses of this container/host, for DATA_API_URL on a bot running on the same node.
  const internal = Object.values(require('os').networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${PORT}`);
  if (internal.length) console.log(`[internal] Bot DATA_API_URL candidates: ${internal.join(' , ')}`);
  const missing = Object.keys(INTERNAL_FUNCTIONS).filter((name) => typeof INTERNAL_FUNCTIONS[name] !== 'function');
  if (missing.length) console.error(`[internal] Outdated files: missing ${missing.join(', ')}. Upload the latest usage-db.js and admin-settings.js.`);
  console.log(`Forwarding /v1/* -> ${UPSTREAM_BASE_URL}/*`);
});

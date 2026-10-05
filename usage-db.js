const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getBillingPrice, getModelFamily, PINNED_MODELS } = require('./pricing');
const { getReferralSettings } = require('./admin-settings');

const configuredDatabasePath = process.env.USAGE_DB_PATH;
const databasePath = configuredDatabasePath
  ? (path.isAbsolute(configuredDatabasePath) ? configuredDatabasePath : path.resolve(__dirname, configuredDatabasePath))
  : path.join(__dirname, 'data', 'users.json');
const lockPath = `${databasePath}.lock`;

function emptyDatabase() {
  return { users: {}, adminLogs: [] };
}

function readDatabase() {
  try {
    return JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDatabase();
    throw new Error(`Database read failed; refusing to reset data: ${error.message}`);
  }
}

function writeDatabaseUnlocked(database) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2), 'utf8');
  if (fs.existsSync(databasePath)) fs.copyFileSync(databasePath, `${databasePath}.bak`);
  fs.renameSync(temporaryPath, databasePath);
}

// ---------------------------------------------------------------------------
// File locks (users.json.lock, prompts.json.lock, moderation.json.lock).
//
// A write holds its lock for milliseconds. Waiting for a lock uses exponential
// backoff with jitter; when the wait budget runs out a DatabaseBusyError
// (code EDB_BUSY) is thrown BEFORE anything was read or written, so the caller
// can always retry it safely.
//
// The lock file records its owner (pid + host). A lock whose owner process is
// gone, or that is older than LOCK_STALE_MS, was left behind by a process that
// died mid-write (restart, kill, OOM) and is removed; before this, one such
// file made every later write fail with "Database is busy" forever.
// The two env variables only exist so tests can shorten the timings.
// ---------------------------------------------------------------------------
const LOCK_WAIT_MS = Number(process.env.USAGE_DB_LOCK_WAIT_MS) || 6_000; // was 400 x 15 ms
const LOCK_STALE_MS = Number(process.env.USAGE_DB_LOCK_STALE_MS) || 30_000;
const LOCK_BACKOFF_START_MS = 5;
const LOCK_BACKOFF_MAX_MS = 250;
// EPERM/EBUSY: on Windows a lock file that is being deleted cannot be re-created for a moment.
const TRANSIENT_LOCK_ERRORS = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const HOSTNAME = os.hostname();
const heldLocks = new Set(); // lock paths this process holds right now

class DatabaseBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseBusyError';
    this.code = 'EDB_BUSY';
  }
}

function isDatabaseBusyError(error) {
  return Boolean(error) && error.code === 'EDB_BUSY';
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, but belongs to another user
  }
}

// { raw, mtimeMs, owner } of the current lock file, null when it is gone,
// undefined when it cannot be read right now.
function readLockFile(lockFilePath) {
  try {
    const stat = fs.statSync(lockFilePath);
    const raw = fs.readFileSync(lockFilePath, 'utf8');
    let owner = {};
    try {
      owner = JSON.parse(raw) || {};
    } catch (_) {
      // Empty: created a moment ago and not written yet, or made by an older version of this file.
    }
    return { raw, mtimeMs: stat.mtimeMs, owner };
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined;
  }
}

function lockIsStale(lockFilePath, lock) {
  if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) return true;
  const { pid, host } = lock.owner;
  // A pid is only meaningful on the host that wrote it.
  if (host !== HOSTNAME || !Number.isInteger(pid)) return false;
  // Our own pid on a lock we do not hold: left by an earlier process that had this pid.
  if (pid === process.pid) return !heldLocks.has(lockFilePath);
  return !processIsAlive(pid);
}

function breakStaleLock(lockFilePath, lock) {
  // Move it aside first, then make sure what was moved is the lock judged stale:
  // if another process replaced it in between, put that fresh lock back.
  const asidePath = `${lockFilePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lockFilePath, asidePath);
  } catch (error) {
    return; // already gone or not movable right now: the caller just retries
  }
  const moved = readLockFile(asidePath);
  if (moved && (moved.raw !== lock.raw || moved.mtimeMs !== lock.mtimeMs)) {
    try {
      fs.linkSync(asidePath, lockFilePath);
    } catch (_) { /* a newer lock exists already */ }
  } else {
    const ageSeconds = Math.round((Date.now() - lock.mtimeMs) / 1000);
    console.warn(`[db] removed stale lock ${path.basename(lockFilePath)} (owner ${lock.raw || 'unknown'}, ${ageSeconds}s old)`);
  }
  fs.rmSync(asidePath, { force: true });
}

function acquireLock(lockFilePath, busyMessage) {
  const token = JSON.stringify({ pid: process.pid, host: HOSTNAME, at: new Date().toISOString(), id: crypto.randomBytes(6).toString('hex') });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let backoff = LOCK_BACKOFF_START_MS;
  let lastError;
  for (;;) {
    let retryNow = false;
    try {
      const handle = fs.openSync(lockFilePath, 'wx');
      heldLocks.add(lockFilePath);
      try {
        fs.writeSync(handle, token);
        return { handle, token };
      } catch (_) {
        return { handle, token: '' }; // the owner record only helps stale-lock detection
      }
    } catch (error) {
      if (!TRANSIENT_LOCK_ERRORS.has(error.code)) throw error;
      lastError = error;
      if (error.code === 'EEXIST') {
        const current = readLockFile(lockFilePath);
        if (current === null) {
          retryNow = true; // released in the meantime
        } else if (current && lockIsStale(lockFilePath, current)) {
          breakStaleLock(lockFilePath, current);
          retryNow = true;
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // EPERM/EBUSY that never cleared is a real file-system problem, not contention: report it as is.
      if (lastError && lastError.code !== 'EEXIST') throw lastError;
      throw new DatabaseBusyError(busyMessage);
    }
    if (!retryNow) {
      sleepSync(Math.min(remaining, backoff + Math.floor(Math.random() * backoff)));
      backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
    }
  }
}

function releaseLock(lockFilePath, lock) {
  heldLocks.delete(lockFilePath);
  try {
    fs.closeSync(lock.handle);
  } catch (error) {
    console.error(`[db] could not close ${path.basename(lockFilePath)}:`, error.message);
  }
  try {
    // Only delete the lock while it is still ours. A failure here is logged, never thrown:
    // it must not hide the write's result, and a leftover lock is recovered as stale.
    if (fs.readFileSync(lockFilePath, 'utf8') === lock.token) fs.unlinkSync(lockFilePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[db] could not release ${path.basename(lockFilePath)}:`, error.message);
  }
}

function withFileLock(lockFilePath, busyMessage, work) {
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
  const lock = acquireLock(lockFilePath, busyMessage);
  try {
    return work();
  } finally {
    releaseLock(lockFilePath, lock);
  }
}

function mutateDatabase(mutator) {
  return withFileLock(lockPath, 'Database is busy; try again', () => {
    const database = readDatabase();
    const result = mutator(database);
    writeDatabaseUnlocked(database);
    return result;
  });
}

function newUser(telegramId, profile = {}) {
  return {
    telegramId: String(telegramId),
    username: profile.username || '',
    firstName: profile.firstName || '',
    createdAt: new Date().toISOString(),
    apiKeys: [],
    balance: 0,
    orders: [],
    stats: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errors: 0, spent: 0 },
    logs: [],
  };
}

function createOrder(telegramId, order) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id);
    user.orders.push({ ...order, createdAt: new Date().toISOString(), status: 'PENDING' });
    user.orders = user.orders.slice(-50);
    database.users[id] = user;
    return user.orders[user.orders.length - 1];
  });
}

function settleOrder(orderId, amount) {
  return mutateDatabase((database) => {
    for (const user of Object.values(database.users)) {
      const order = user.orders.find((entry) => entry.orderId === orderId);
      if (!order) continue;
      if (order.status === 'SETTLED') return { settled: false, userId: user.telegramId, balance: user.balance };
      order.status = 'SETTLED';
      order.settledAt = new Date().toISOString();
      order.paidAmount = Number(amount || order.amount);
      user.balance += Number(order.amount);
      return { settled: true, userId: user.telegramId, balance: user.balance };
    }
    return null;
  });
}

function ensureUser(telegramId, profile = {}) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    Object.assign(user, { username: profile.username || user.username, firstName: profile.firstName || user.firstName });
    database.users[id] = user;
    return user;
  });
}

const SUPPORTED_LANGUAGES = ['en', 'id'];

// Saves the bot language a user picked on /start; reused for every later reply.
function setUserLanguage(telegramId, language, profile = {}) {
  const lang = String(language || '').toLowerCase();
  if (!SUPPORTED_LANGUAGES.includes(lang)) throw new Error(`Unsupported language: ${language}`);
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    user.language = lang;
    database.users[id] = user;
    return user;
  });
}

function createApiKey(telegramId, profile = {}) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    const key = `sk-user-${crypto.randomBytes(24).toString('hex')}`;
    user.apiKeys.push({ key, createdAt: new Date().toISOString(), active: true });
    database.users[id] = user;
    return key;
  });
}

function findUserByApiKey(apiKey) {
  if (!apiKey) return null;
  const database = readDatabase();
  for (const user of Object.values(database.users)) {
    if (user.apiKeys.some((entry) => entry.key === apiKey && entry.active !== false)) return user;
  }
  return null;
}

function recordUsage(apiKey, usage = {}) {
  return mutateDatabase((database) => {
    let owner;
    for (const user of Object.values(database.users)) {
      if (user.apiKeys.some((entry) => entry.key === apiKey && entry.active !== false)) {
        owner = user;
        break;
      }
    }
    if (!owner) return false;

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const statusCode = Number(usage.statusCode || 200);
  const totalTokens = inputTokens + outputTokens;
  const pricePerMillion = Number(usage.pricePerMillion ?? getBillingPrice(usage.model));
  // Bonus tokens (referral rewards) pay for billed tokens first; the rest is
  // charged to the Rp balance. Free models / free mode do not use bonus tokens.
  const bonusAvailable = Math.max(0, Number(owner.bonusTokens || 0));
  const bonusTokensUsed = pricePerMillion > 0 ? Math.min(bonusAvailable, totalTokens) : 0;
  owner.bonusTokens = bonusAvailable - bonusTokensUsed;
  const cost = pricePerMillion ? ((totalTokens - bonusTokensUsed) / 1_000_000) * pricePerMillion : 0;
  owner.stats.bonusTokensUsed = Number(owner.stats.bonusTokensUsed || 0) + bonusTokensUsed;
  owner.stats.requests += 1;
  owner.stats.inputTokens += inputTokens;
  owner.stats.outputTokens += outputTokens;
  owner.stats.totalTokens += totalTokens;
  owner.stats.spent = Number(owner.stats.spent || 0) + cost;
  owner.balance = Math.max(0, Number(owner.balance || 0) - cost);
  if (statusCode >= 400) owner.stats.errors += 1;
  owner.lastUsedAt = new Date().toISOString();
  owner.logs.push({
    at: owner.lastUsedAt,
    endpoint: usage.endpoint || '',
    status: statusCode,
    inputTokens,
    outputTokens,
    model: usage.model || '',
    pricePerMillion,
    cost,
    bonusTokensUsed,
  });
  owner.logs = owner.logs.slice(-50);
    return { cost, bonusTokensUsed, balance: owner.balance, bonusTokens: owner.bonusTokens };
  });
}

function getUser(telegramId) {
  return readDatabase().users[String(telegramId)] || null;
}

function getAllUsers() {
  return Object.values(readDatabase().users);
}

function recordAdminRequest(log) {
  mutateDatabase((database) => {
    database.adminLogs = Array.isArray(database.adminLogs) ? database.adminLogs : [];
    database.adminLogs.push({ at: new Date().toISOString(), ...log });
    database.adminLogs = database.adminLogs.slice(-500);
  });
}

function getAdminLogs(limit = 50) {
  const database = readDatabase();
  return (database.adminLogs || []).slice(-Number(limit)).reverse();
}

function addBalance(telegramId, amount) {
  return adjustBalance(telegramId, Math.abs(Number(amount)));
}

function adjustBalance(telegramId, delta) {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return null;
  return mutateDatabase((database) => {
    const user = database.users[String(telegramId)];
    if (!user) return null;
    user.balance = Math.max(0, Number(user.balance || 0) + value);
    user.lastBalanceTopUpAt = new Date().toISOString();
    return user.balance;
  });
}

function getOrder(telegramId, orderId) {
  const user = getUser(telegramId);
  return user?.orders.find((order) => order.orderId === orderId) || null;
}

function revokeApiKey(telegramId, index) {
  return mutateDatabase((database) => {
    const user = database.users[String(telegramId)];
    if (!user) return null;
    const activeKeys = user.apiKeys.filter((entry) => entry.active !== false);
    const key = activeKeys[Number(index)];
    if (!key) return null;
    key.active = false;
    key.revokedAt = new Date().toISOString();
    return key.key;
  });
}

// ---------------------------------------------------------------------------
// Redeem codes: admin creates a code worth a fixed nominal; each user can use a
// given code once, and a code stops working after `maxUses` redemptions.
// ---------------------------------------------------------------------------

function normalizeRedeemCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function redeemCodeTable(database) {
  if (!database.redeemCodes || typeof database.redeemCodes !== 'object' || Array.isArray(database.redeemCodes)) {
    database.redeemCodes = {};
  }
  return database.redeemCodes;
}

function createRedeemCode({ amount, maxUses = 1, createdBy = '' } = {}) {
  const value = Math.round(Number(amount));
  const uses = Number(maxUses);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(uses) || uses <= 0) return null;
  return mutateDatabase((database) => {
    const codes = redeemCodeTable(database);
    let code;
    do {
      code = `RDM-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    } while (codes[code]);
    const entry = {
      code,
      amount: value,
      maxUses: uses,
      redemptions: [],
      active: true,
      createdAt: new Date().toISOString(),
      createdBy: String(createdBy),
    };
    codes[code] = entry;
    return entry;
  });
}

// Atomic: validation, balance credit and redemption record happen under one lock,
// so two users racing for the last slot cannot both succeed.
function redeemCode(telegramId, rawCode, profile = {}) {
  const code = normalizeRedeemCode(rawCode);
  if (!code) return { ok: false, reason: 'not_found' };
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const entry = redeemCodeTable(database)[code];
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.active === false) return { ok: false, reason: 'disabled' };
    entry.redemptions = Array.isArray(entry.redemptions) ? entry.redemptions : [];
    if (entry.redemptions.some((item) => item.telegramId === id)) return { ok: false, reason: 'already_redeemed' };
    if (entry.redemptions.length >= entry.maxUses) return { ok: false, reason: 'used_up' };

    const user = database.users[id] || newUser(id, profile);
    database.users[id] = user;
    const at = new Date().toISOString();
    user.balance = Number(user.balance || 0) + Number(entry.amount);
    user.redeemedCodes = Array.isArray(user.redeemedCodes) ? user.redeemedCodes : [];
    user.redeemedCodes.push({ code, amount: entry.amount, at });
    user.redeemedCodes = user.redeemedCodes.slice(-50);
    entry.redemptions.push({ telegramId: id, at });
    return { ok: true, code, amount: entry.amount, balance: user.balance, usesLeft: entry.maxUses - entry.redemptions.length };
  });
}

function listRedeemCodes(limit = 15) {
  const codes = Object.values(readDatabase().redeemCodes || {});
  return codes.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Number(limit));
}

function disableRedeemCode(rawCode) {
  const code = normalizeRedeemCode(rawCode);
  return mutateDatabase((database) => {
    const entry = redeemCodeTable(database)[code];
    if (!entry) return null;
    entry.active = false;
    entry.disabledAt = new Date().toISOString();
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Model access codes (bot: Admin Panel -> Kode Akses Model). The admin binds one or
// more models and a period to a unique single-use code "MDL-XXXXXX-XXXXXX". The user
// who redeems it gets a grant: while the grant is active their API keys may ONLY use
// those models (server.js checks this on every /v1 request). Whether a grant is active
// is worked out from the clock on every check, so once it ends the user's model access
// is back to normal by itself; no timer is involved.
//
// Period kinds:
//   duration  access lasts `durationMs` from the moment of redemption; the code can be
//             redeemed until `expiresAt` (redeem deadline, default 30 days).
//   range     access runs in the fixed window startsAt..endsAt; the code can be redeemed
//             until endsAt. Redeemed before startsAt = the grant waits for startsAt.
//
// database.accessCodes = { <code>: { code, models: [model keys], kind, durationMs,
//   startsAt, endsAt, expiresAt, active, createdAt, createdBy, disabledAt?, disabledBy?,
//   redemption: null | { telegramId, at, startsAt, endsAt, revokedAt? } } }
// user.modelAccess = [ { code, models, startsAt, endsAt, redeemedAt, revokedAt? } ]
// Several active grants of one user add up: the user may use every model of all of them.
// Creating and disabling codes is refused here unless the caller is ADMIN_TELEGRAM_ID.
// ---------------------------------------------------------------------------

// Same variable and default as server.js and telegram-bot.js.
const ACCESS_ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '6957236291').trim();
const ACCESS_CODE_PATTERN = /^MDL-[A-F0-9]{6}-[A-F0-9]{6}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ACCESS_PERIOD_MS = 60 * 1000;
const MAX_ACCESS_PERIOD_MS = 365 * DAY_MS;
const MAX_ACCESS_AHEAD_MS = 365 * DAY_MS; // latest start of a fixed window / redeem deadline
const DEFAULT_ACCESS_REDEEM_WINDOW_MS = 30 * DAY_MS;
const MAX_ACCESS_MODELS = 50;
const MAX_ACCESS_GRANT_HISTORY = 20; // finished grants kept per user (open ones are never pruned)
const ACCESS_MODEL_NAME = /^[a-z0-9][a-z0-9._:+-]{0,99}$/;
const modelCachePath = path.join(__dirname, 'data', 'models.json');

// Display name, lowercase: same key as admin-settings.js uses for disabled models.
function accessModelKey(model) {
  return String(model || '').trim().replace(/^.*\//, '').toLowerCase();
}

function isAccessAdmin(telegramId) {
  return Boolean(ACCESS_ADMIN_ID) && String(telegramId ?? '').trim() === ACCESS_ADMIN_ID;
}

function accessCodeTable(database) {
  if (!database.accessCodes || typeof database.accessCodes !== 'object' || Array.isArray(database.accessCodes)) {
    database.accessCodes = {};
  }
  return database.accessCodes;
}

// Models the bot last synced from upstream (data/models.json) plus the pinned ones, or null
// when that list is not available here (then only the model family is checked).
function knownModelKeys() {
  try {
    const cache = JSON.parse(fs.readFileSync(modelCachePath, 'utf8'));
    if (!Array.isArray(cache.models) || !cache.models.length) return null;
    return new Set([...cache.models, ...Object.keys(PINNED_MODELS)].map(accessModelKey));
  } catch (_) {
    return null;
  }
}

function normalizeAccessModels(models) {
  const list = Array.isArray(models) ? models : [models];
  const keys = [...new Set(list.map(accessModelKey).filter(Boolean))];
  if (!keys.length) throw new Error('Choose at least one model');
  if (keys.length > MAX_ACCESS_MODELS) throw new Error(`At most ${MAX_ACCESS_MODELS} models per access code`);
  const known = knownModelKeys();
  for (const key of keys) {
    if (!ACCESS_MODEL_NAME.test(key) || !getModelFamily(key)) throw new Error(`Unsupported model: ${key.slice(0, 100)}`);
    if (known && !known.has(key)) throw new Error(`Unknown model: ${key}. Resync the model list and try again.`);
  }
  return keys.sort();
}

function parseAccessTime(value, label) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid ${label} time`);
  return time;
}

function isoTime(time) {
  return new Date(time).toISOString();
}

function accessGrantStatus(grant, now = Date.now()) {
  if (grant.revokedAt) return 'revoked';
  const start = Date.parse(grant.startsAt);
  const end = Date.parse(grant.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now >= end) return 'ended';
  if (now < start) return 'scheduled';
  return 'active';
}

function isGrantOpen(grant, now) {
  const status = accessGrantStatus(grant, now);
  return status === 'active' || status === 'scheduled';
}

function validGrants(user) {
  return (Array.isArray(user?.modelAccess) ? user.modelAccess : [])
    .filter((grant) => grant && typeof grant.code === 'string' && Array.isArray(grant.models));
}

// What the user's redeemed access codes mean at `now`. Pure (no file access), so
// server.js can run it on the user record it already has for every request.
// `restricted` false = normal model access. While true, only `allowedModels` may be used.
function modelAccessFor(user, now = Date.now()) {
  const grants = validGrants(user).map((grant) => ({
    code: grant.code,
    models: grant.models.map(accessModelKey).filter(Boolean),
    startsAt: grant.startsAt,
    endsAt: grant.endsAt,
    redeemedAt: grant.redeemedAt || null,
    status: accessGrantStatus(grant, now),
  }));
  const active = grants.filter((grant) => grant.status === 'active')
    .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const scheduled = grants.filter((grant) => grant.status === 'scheduled')
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const allowedModels = active.length ? [...new Set(active.flatMap((grant) => grant.models))].sort() : null;
  return {
    restricted: active.length > 0,
    allowedModels,
    // The current restriction lasts at least until the last active grant ends.
    restrictedUntil: active.length ? active[active.length - 1].endsAt : null,
    active,
    scheduled,
  };
}

function getModelAccess(telegramId) {
  return modelAccessFor(getUser(telegramId));
}

function pruneGrants(grants, now) {
  const finished = grants.filter((grant) => !isGrantOpen(grant, now))
    .sort((a, b) => String(b.revokedAt || b.endsAt).localeCompare(String(a.revokedAt || a.endsAt)))
    .slice(0, MAX_ACCESS_GRANT_HISTORY);
  return grants.filter((grant) => isGrantOpen(grant, now) || finished.includes(grant));
}

// available | expired | disabled (never redeemed) or in_use | scheduled | finished | revoked.
function accessCodeStatus(entry, now = Date.now()) {
  const redemption = entry.redemption;
  if (redemption) {
    const status = accessGrantStatus(redemption, now);
    if (status === 'revoked') return 'revoked';
    if (status === 'active') return 'in_use';
    return status === 'scheduled' ? 'scheduled' : 'finished';
  }
  if (entry.active === false) return 'disabled';
  if (!(now < Date.parse(entry.expiresAt))) return 'expired';
  return 'available';
}

// A copy for callers, with the computed status and the redeemer's name.
function accessCodeSummary(entry, users = {}, now = Date.now()) {
  const redemption = entry.redemption ? { ...entry.redemption } : null;
  if (redemption) {
    const user = users[redemption.telegramId];
    redemption.firstName = user?.firstName || '';
    redemption.username = user?.username || '';
  }
  return {
    code: entry.code,
    models: Array.isArray(entry.models) ? [...entry.models] : [],
    kind: entry.kind,
    durationMs: entry.durationMs ?? null,
    startsAt: entry.startsAt ?? null,
    endsAt: entry.endsAt ?? null,
    expiresAt: entry.expiresAt,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy || '',
    disabledAt: entry.disabledAt || null,
    status: accessCodeStatus(entry, now),
    redemption,
  };
}

// Admin only. `kind` 'duration' needs `durationMs` (+ optional `expiresAt` redeem deadline);
// 'range' needs `endsAt` (+ optional `startsAt`, missing or past = now). Throws a readable
// reason when anything is not acceptable; nothing the caller sends is trusted.
function createAccessCode({ models, kind, durationMs, startsAt, endsAt, expiresAt, createdBy } = {}) {
  if (!isAccessAdmin(createdBy)) throw new Error('Only the admin can create model access codes');
  const modelKeys = normalizeAccessModels(models);
  const now = Date.now();
  const period = { kind, durationMs: null, startsAt: null, endsAt: null, expiresAt: null };
  if (kind === 'duration') {
    const duration = Number(durationMs);
    if (!Number.isSafeInteger(duration) || duration < MIN_ACCESS_PERIOD_MS) throw new Error('The access period must be at least 1 minute');
    if (duration > MAX_ACCESS_PERIOD_MS) throw new Error('The access period can be at most 365 days');
    const deadline = expiresAt === undefined || expiresAt === null || expiresAt === ''
      ? now + DEFAULT_ACCESS_REDEEM_WINDOW_MS
      : parseAccessTime(expiresAt, 'redeem deadline');
    if (deadline - now < MIN_ACCESS_PERIOD_MS) throw new Error('The redeem deadline must be at least 1 minute from now');
    if (deadline - now > MAX_ACCESS_AHEAD_MS) throw new Error('The redeem deadline can be at most 365 days ahead');
    period.durationMs = duration;
    period.expiresAt = isoTime(deadline);
  } else if (kind === 'range') {
    const start = startsAt ? Math.max(now, parseAccessTime(startsAt, 'start')) : now;
    if (start - now > MAX_ACCESS_AHEAD_MS) throw new Error('The start time can be at most 365 days ahead');
    if (endsAt === undefined || endsAt === null || endsAt === '') throw new Error('Set the end time of the access period');
    const end = parseAccessTime(endsAt, 'end');
    if (end - start < MIN_ACCESS_PERIOD_MS) throw new Error('The end time must be at least 1 minute after the start');
    if (end - start > MAX_ACCESS_PERIOD_MS) throw new Error('The access period can be at most 365 days');
    period.startsAt = isoTime(start);
    period.endsAt = isoTime(end);
    period.expiresAt = period.endsAt;
  } else {
    throw new Error('Choose how the access period is counted (duration or fixed range)');
  }
  return mutateDatabase((database) => {
    const codes = accessCodeTable(database);
    let code;
    do {
      code = `MDL-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    } while (codes[code]);
    const entry = {
      code,
      models: modelKeys,
      ...period,
      active: true,
      redemption: null,
      createdAt: isoTime(now),
      createdBy: String(createdBy).trim(),
    };
    codes[code] = entry;
    return accessCodeSummary(entry, database.users || {}, now);
  });
}

// Atomic: checks, the user's grant and the code's redemption are written under one lock,
// so a code can never be redeemed twice. Answers { ok: false, reason } with reason
// not_found | already_redeemed | used | disabled | expired, or { ok: true, ... }.
function redeemAccessCode(telegramId, rawCode, profile = {}) {
  const code = normalizeRedeemCode(rawCode);
  if (!ACCESS_CODE_PATTERN.test(code)) return { ok: false, reason: 'not_found' };
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const entry = accessCodeTable(database)[code];
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.redemption) return { ok: false, reason: entry.redemption.telegramId === id ? 'already_redeemed' : 'used' };
    if (entry.active === false) return { ok: false, reason: 'disabled' };
    const now = Date.now();
    if (!(now < Date.parse(entry.expiresAt))) return { ok: false, reason: 'expired' };
    const start = entry.kind === 'range' ? Math.max(now, Date.parse(entry.startsAt)) : now;
    const end = entry.kind === 'range' ? Date.parse(entry.endsAt) : now + Number(entry.durationMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { ok: false, reason: 'expired' };

    const user = database.users[id] || newUser(id, profile);
    database.users[id] = user;
    const at = isoTime(now);
    const grant = { code, models: [...entry.models], startsAt: isoTime(start), endsAt: isoTime(end), redeemedAt: at };
    user.modelAccess = pruneGrants([...validGrants(user), grant], now);
    entry.redemption = { telegramId: id, at, startsAt: grant.startsAt, endsAt: grant.endsAt };
    return {
      ok: true,
      code,
      models: grant.models,
      kind: entry.kind,
      startsAt: grant.startsAt,
      endsAt: grant.endsAt,
      status: accessGrantStatus(grant, now),
      access: modelAccessFor(user, now),
    };
  });
}

// Newest first.
function listAccessCodes(limit = 10) {
  const database = readDatabase();
  const now = Date.now();
  return Object.values(database.accessCodes || {})
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Number(limit) || 10))
    .map((entry) => accessCodeSummary(entry, database.users || {}, now));
}

function getAccessCode(rawCode) {
  const database = readDatabase();
  const entry = (database.accessCodes || {})[normalizeRedeemCode(rawCode)];
  return entry ? accessCodeSummary(entry, database.users || {}) : null;
}

// Admin only. A code nobody redeemed yet can no longer be redeemed; a redeemed code whose
// period is still running (or waiting to start) ends now, so that user's model access is
// back to normal at once. Null = no such code; { changed: false } = nothing left to stop.
function disableAccessCode(rawCode, disabledBy) {
  if (!isAccessAdmin(disabledBy)) throw new Error('Only the admin can disable model access codes');
  const code = normalizeRedeemCode(rawCode);
  return mutateDatabase((database) => {
    const entry = accessCodeTable(database)[code];
    if (!entry) return null;
    const now = Date.now();
    const previousStatus = accessCodeStatus(entry, now);
    if (!['available', 'in_use', 'scheduled'].includes(previousStatus)) {
      return { changed: false, previousStatus, code: accessCodeSummary(entry, database.users || {}, now) };
    }
    const at = isoTime(now);
    entry.active = false;
    entry.disabledAt = at;
    entry.disabledBy = String(disabledBy).trim();
    if (entry.redemption) {
      entry.redemption.revokedAt = at;
      const user = database.users[entry.redemption.telegramId];
      for (const grant of validGrants(user)) {
        if (grant.code === code && !grant.revokedAt) grant.revokedAt = at;
      }
    }
    return { changed: true, previousStatus, code: accessCodeSummary(entry, database.users || {}, now) };
  });
}

// ---------------------------------------------------------------------------
// Referrals: every user gets a code for the link t.me/<bot>?start=<code>. When a
// NEW user (no account yet) starts the bot with someone's code, the inviter is
// credited with bonus tokens. Abuse guards, all checked under the DB lock:
//  - only brand-new accounts count, so re-sending /start <code> never pays again
//    and an invited user is credited to one inviter only (`referredBy` is set once);
//  - an inviter cannot use their own code;
//  - optional per-inviter cap on paid invites (admin setting).
// ---------------------------------------------------------------------------

const REFERRAL_CODE_PATTERN = /^ref_[a-f0-9]{10}$/;
const MAX_REFERRAL_HISTORY = 100;

function ensureReferralCode(database, user) {
  if (user.referralCode) return user.referralCode;
  const taken = new Set(Object.values(database.users).map((entry) => entry.referralCode).filter(Boolean));
  let code;
  do {
    code = `ref_${crypto.randomBytes(5).toString('hex')}`;
  } while (taken.has(code));
  user.referralCode = code;
  return code;
}

function referralSummary(user, settings = getReferralSettings()) {
  const stats = user.referralStats || {};
  return {
    code: user.referralCode || '',
    invites: Number(stats.invites || 0),
    rewardedInvites: Number(stats.rewarded || 0),
    tokensEarned: Number(stats.tokensEarned || 0),
    bonusTokens: Number(user.bonusTokens || 0),
    referredBy: user.referredBy?.telegramId || null,
    settings,
  };
}

// Returns the user's referral code (created on first use) and their referral stats.
function getReferralInfo(telegramId, profile = {}) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    database.users[id] = user;
    ensureReferralCode(database, user);
    return referralSummary(user);
  });
}

// Used by the bot for every /start: creates the account like ensureUser and, when
// `rawCode` is a valid referral code and the account is new, credits the inviter.
// `referral.reason` explains a non-credit: disabled, invalid, not_new, self,
// cap_reached (invite recorded, no reward).
function startWithReferral(telegramId, profile = {}, rawCode = '') {
  const code = String(rawCode || '').trim().toLowerCase();
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const isNew = !database.users[id];
    const user = database.users[id] || newUser(id, profile);
    Object.assign(user, { username: profile.username || user.username, firstName: profile.firstName || user.firstName });
    database.users[id] = user;
    if (!code) return { user, referral: null };

    const settings = getReferralSettings();
    const result = (referral) => ({ user, referral });
    if (!settings.enabled) return result({ credited: false, reason: 'disabled' });
    if (!REFERRAL_CODE_PATTERN.test(code)) return result({ credited: false, reason: 'invalid' });
    const referrer = Object.values(database.users).find((entry) => entry.referralCode === code);
    if (!referrer) return result({ credited: false, reason: 'invalid' });
    if (referrer.telegramId === id) return result({ credited: false, reason: 'self' });
    if (!isNew || user.referredBy) return result({ credited: false, reason: 'not_new' });

    const at = new Date().toISOString();
    const stats = referrer.referralStats || { invites: 0, rewarded: 0, tokensEarned: 0 };
    const capReached = settings.maxRewardsPerUser > 0 && Number(stats.rewarded || 0) >= settings.maxRewardsPerUser;
    const reward = capReached ? 0 : settings.rewardTokens;
    stats.invites = Number(stats.invites || 0) + 1;
    if (reward) {
      stats.rewarded = Number(stats.rewarded || 0) + 1;
      stats.tokensEarned = Number(stats.tokensEarned || 0) + reward;
      referrer.bonusTokens = Number(referrer.bonusTokens || 0) + reward;
    }
    referrer.referralStats = stats;
    referrer.referrals = [...(Array.isArray(referrer.referrals) ? referrer.referrals : []), { telegramId: id, at, reward }].slice(-MAX_REFERRAL_HISTORY);
    user.referredBy = { telegramId: referrer.telegramId, code, at };
    return result({
      credited: reward > 0,
      reason: reward > 0 ? 'credited' : 'cap_reached',
      reward,
      referrerId: referrer.telegramId,
      referrerName: referrer.firstName || referrer.username || '',
      referrerBonusTokens: referrer.bonusTokens || 0,
      referrerInvites: stats.invites,
    });
  });
}

// Zeroes the usage statistics on the admin dashboard: every user's request /
// token / error / spent counters, every user's request log, and the admin
// request log (the "last 24h" numbers). Balances, API keys, orders, redeem
// codes, tickets and settings are NOT touched. A full copy of the database is
// written next to it first, so a reset can be undone by restoring that file.
function resetStats(resetBy = '') {
  return mutateDatabase((database) => {
    const at = new Date().toISOString();
    const backupPath = `${databasePath}.stats-reset-${at.replace(/[:.]/g, '-')}.bak`;
    fs.writeFileSync(backupPath, JSON.stringify(database, null, 2), 'utf8');
    let users = 0;
    for (const user of Object.values(database.users || {})) {
      user.stats = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errors: 0, spent: 0 };
      user.logs = [];
      users += 1;
    }
    database.adminLogs = [];
    database.statsResetAt = at;
    database.statsResetBy = String(resetBy);
    return { at, users, backup: path.basename(backupPath) };
  });
}

// Aggregated numbers for the admin dashboard. Lifetime totals come from the
// per-user counters; the 24h window comes from the (capped) admin request log.
function getAdminStats() {
  const database = readDatabase();
  const users = Object.values(database.users || {});
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const stats = {
    totalUsers: users.length,
    activeUsers: 0,
    newUsers24h: 0,
    activeKeys: 0,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    spent: 0,
    totalBalance: 0,
    revenue: 0,
    settledOrders: 0,
    pendingOrders: 0,
    redeemCodes: 0,
    activeRedeemCodes: 0,
    redemptions: 0,
    redeemedAmount: 0,
    accessCodes: 0,
    accessCodesAvailable: 0,
    accessCodesInUse: 0,
    last24h: { requests: 0, errors: 0, avgMs: 0 },
    referralInvites: 0,
    referralRewarded: 0,
    referralTokensAwarded: 0,
    bonusTokensLeft: 0,
    bonusTokensUsed: 0,
    statsResetAt: database.statsResetAt || null,
  };

  for (const user of users) {
    const s = user.stats || {};
    const r = user.referralStats || {};
    stats.referralInvites += Number(r.invites || 0);
    stats.referralRewarded += Number(r.rewarded || 0);
    stats.referralTokensAwarded += Number(r.tokensEarned || 0);
    stats.bonusTokensLeft += Number(user.bonusTokens || 0);
    stats.bonusTokensUsed += Number(s.bonusTokensUsed || 0);
    stats.requests += Number(s.requests || 0);
    stats.errors += Number(s.errors || 0);
    stats.inputTokens += Number(s.inputTokens || 0);
    stats.outputTokens += Number(s.outputTokens || 0);
    stats.totalTokens += Number(s.totalTokens || 0);
    stats.spent += Number(s.spent || 0);
    stats.totalBalance += Number(user.balance || 0);
    if (Number(s.requests || 0) > 0) stats.activeUsers += 1;
    if (Date.parse(user.createdAt) >= dayAgo) stats.newUsers24h += 1;
    stats.activeKeys += (user.apiKeys || []).filter((entry) => entry.active !== false).length;
    for (const order of user.orders || []) {
      if (order.status === 'SETTLED') {
        stats.settledOrders += 1;
        stats.revenue += Number(order.amount || 0);
      } else if (order.status === 'PENDING') {
        stats.pendingOrders += 1;
      }
    }
  }
  stats.success = Math.max(0, stats.requests - stats.errors);
  stats.successRate = stats.requests ? (stats.success / stats.requests) * 100 : 0;

  for (const entry of Object.values(database.redeemCodes || {})) {
    const used = (entry.redemptions || []).length;
    stats.redeemCodes += 1;
    if (entry.active !== false && used < entry.maxUses) stats.activeRedeemCodes += 1;
    stats.redemptions += used;
    stats.redeemedAmount += used * Number(entry.amount || 0);
  }

  const now = Date.now();
  for (const entry of Object.values(database.accessCodes || {})) {
    const status = accessCodeStatus(entry, now);
    stats.accessCodes += 1;
    if (status === 'available') stats.accessCodesAvailable += 1;
    if (status === 'in_use' || status === 'scheduled') stats.accessCodesInUse += 1;
  }

  let durationTotal = 0;
  for (const log of database.adminLogs || []) {
    if (Date.parse(log.at) < dayAgo) continue;
    stats.last24h.requests += 1;
    if (Number(log.status) >= 400) stats.last24h.errors += 1;
    durationTotal += Number(log.durationMs || 0);
  }
  stats.last24h.avgMs = stats.last24h.requests ? Math.round(durationTotal / stats.last24h.requests) : 0;
  return stats;
}

// ---------- Support tickets ----------
// Stored in the main database as `tickets` (array) + `nextTicketId`.

const MAX_TICKET_MESSAGES = 200;
const MAX_TICKET_TEXT = 3000;
const MAX_ADMIN_MESSAGE_LINKS = 200;

// Tickets created by the earlier build lived in data/tickets.json; pull them in once.
function ticketTable(database) {
  if (!Array.isArray(database.tickets)) {
    database.tickets = [];
    database.nextTicketId = 1;
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(path.dirname(databasePath), 'tickets.json'), 'utf8'));
      if (Array.isArray(legacy.tickets)) {
        database.tickets = legacy.tickets;
        database.nextTicketId = Number(legacy.nextId) || 1;
      }
    } catch (_) { /* no legacy file */ }
  }
  const highest = database.tickets.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0);
  if (!Number.isInteger(database.nextTicketId) || database.nextTicketId <= highest) database.nextTicketId = highest + 1;
  return database.tickets;
}

function ticketMessage(from, entry) {
  const message = { from, text: String(entry?.text || '').slice(0, MAX_TICKET_TEXT), at: new Date().toISOString() };
  // Attachments are kept as a pointer to the original Telegram message, so the
  // admin can re-open them later with copyMessage.
  if (entry?.media) message.media = { type: String(entry.media.type), chatId: String(entry.media.chatId), messageId: Number(entry.media.messageId) };
  return message;
}

function mutateTicket(ticketId, mutator) {
  return mutateDatabase((database) => {
    const ticket = ticketTable(database).find((t) => t.id === Number(ticketId));
    if (!ticket) return null;
    const result = mutator(ticket);
    if (result === false) return null;
    ticket.updatedAt = new Date().toISOString();
    return ticket;
  });
}

function createTicket(telegramId, profile = {}, entry = {}) {
  return mutateDatabase((database) => {
    const tickets = ticketTable(database);
    const now = new Date().toISOString();
    const ticket = {
      id: database.nextTicketId,
      userId: String(telegramId),
      firstName: profile.firstName || '',
      username: profile.username || '',
      status: 'open',
      createdAt: now,
      updatedAt: now,
      messages: [ticketMessage('user', entry)],
      adminMessageIds: [],
    };
    database.nextTicketId += 1;
    tickets.push(ticket);
    return ticket;
  });
}

function addTicketMessage(ticketId, from, entry) {
  return mutateTicket(ticketId, (ticket) => {
    ticket.messages = [...(ticket.messages || []), ticketMessage(from, entry)].slice(-MAX_TICKET_MESSAGES);
  });
}

// Remember admin-chat messages that belong to a ticket, so a Telegram "reply"
// to any of them is routed back to the right user.
function linkAdminMessage(ticketId, messageId) {
  if (!messageId) return null;
  return mutateTicket(ticketId, (ticket) => {
    ticket.adminMessageIds = [...(ticket.adminMessageIds || []), Number(messageId)].slice(-MAX_ADMIN_MESSAGE_LINKS);
  });
}

function findTicketByAdminMessage(messageId) {
  if (!messageId) return null;
  return ticketTable(readDatabase()).find((t) => (t.adminMessageIds || []).includes(Number(messageId))) || null;
}

function getTicket(ticketId) {
  return ticketTable(readDatabase()).find((t) => t.id === Number(ticketId)) || null;
}

function getOpenTicketForUser(telegramId) {
  return ticketTable(readDatabase()).find((t) => t.userId === String(telegramId) && t.status === 'open') || null;
}

// Every ticket: open ones first, each group newest activity first.
function listTickets() {
  return [...ticketTable(readDatabase())].sort((a, b) => {
    if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function countOpenTickets() {
  return ticketTable(readDatabase()).filter((t) => t.status === 'open').length;
}

function closeTicket(ticketId, closedBy) {
  return mutateTicket(ticketId, (ticket) => {
    if (ticket.status !== 'open') return false;
    ticket.status = 'closed';
    ticket.closedBy = closedBy;
    ticket.closedAt = new Date().toISOString();
  });
}

// ---------- Poll announcements ----------
// Stored in the main database as `polls` (array) + `nextPollId`. An admin sends a poll to
// every user as a message with one button per option. Each user has ONE vote, which they
// can change until the admin closes the poll.
// poll = { id, question, options: [text], createdAt, createdBy, sent, votes: { <telegramId>: optionIndex },
//          closedAt?, closedBy? }
// Callers get `pollSummary` objects (tallies, no voter list), never the raw record.
const MAX_POLL_QUESTION = 300;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 10;
const MAX_POLL_OPTION_LENGTH = 60;
const MAX_POLLS_CLOSED_KEPT = 20; // open polls are never pruned

function pollTable(database) {
  if (!Array.isArray(database.polls)) database.polls = [];
  const highest = database.polls.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0);
  if (!Number.isInteger(database.nextPollId) || database.nextPollId <= highest) database.nextPollId = highest + 1;
  return database.polls;
}

function pollSummary(poll, telegramId) {
  const options = Array.isArray(poll.options) ? poll.options : [];
  const votes = poll.votes && typeof poll.votes === 'object' ? poll.votes : {};
  const counts = options.map(() => 0);
  for (const choice of Object.values(votes)) {
    if (Number.isInteger(choice) && choice >= 0 && choice < counts.length) counts[choice] += 1;
  }
  const summary = {
    id: poll.id,
    question: poll.question,
    options,
    counts,
    total: counts.reduce((sum, count) => sum + count, 0),
    sent: Number(poll.sent) || 0,
    status: poll.closedAt ? 'closed' : 'open',
    createdAt: poll.createdAt,
    createdBy: poll.createdBy || '',
    closedAt: poll.closedAt || null,
    closedBy: poll.closedBy || null,
  };
  // The asking user's own vote (null = has not voted).
  if (telegramId !== undefined) {
    const own = votes[String(telegramId)];
    summary.choice = Number.isInteger(own) && own >= 0 && own < options.length ? own : null;
  }
  return summary;
}

function pruneClosedPolls(database) {
  const closed = database.polls.filter((p) => p.closedAt)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, MAX_POLLS_CLOSED_KEPT);
  database.polls = database.polls.filter((p) => !p.closedAt || closed.includes(p));
}

// Throws a readable message when the question/options are not acceptable.
function createPoll({ question, options, createdBy = '' } = {}) {
  const text = String(question || '').trim();
  const choices = (Array.isArray(options) ? options : []).map((option) => String(option || '').trim()).filter(Boolean);
  if (!text) throw new Error('The poll needs a question');
  if (text.length > MAX_POLL_QUESTION) throw new Error(`The question can be at most ${MAX_POLL_QUESTION} characters`);
  if (choices.length < MIN_POLL_OPTIONS || choices.length > MAX_POLL_OPTIONS) {
    throw new Error(`A poll needs ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} options`);
  }
  if (choices.some((option) => option.length > MAX_POLL_OPTION_LENGTH)) {
    throw new Error(`Each option can be at most ${MAX_POLL_OPTION_LENGTH} characters`);
  }
  if (new Set(choices.map((option) => option.toLowerCase())).size !== choices.length) {
    throw new Error('Each option must be different');
  }
  return mutateDatabase((database) => {
    const polls = pollTable(database);
    const poll = {
      id: database.nextPollId,
      question: text,
      options: choices,
      createdAt: new Date().toISOString(),
      createdBy: String(createdBy),
      sent: 0,
      votes: {},
    };
    database.nextPollId += 1;
    polls.push(poll);
    pruneClosedPolls(database);
    return pollSummary(poll);
  });
}

// Records (or changes) a user's vote. Always answers with { ok, reason?, poll, choice }:
// reason is 'not_found' (no poll), 'closed' or 'invalid_option'; `choice` is the user's
// current vote (null = none), also on a refused vote so the caller can show it.
function votePoll(pollId, telegramId, optionIndex) {
  // Only a real number or a digit string counts: Number(null) would silently become option 0.
  const index = typeof optionIndex === 'number' ? optionIndex
    : (typeof optionIndex === 'string' && /^\d+$/.test(optionIndex) ? Number(optionIndex) : NaN);
  return mutateDatabase((database) => {
    const poll = pollTable(database).find((p) => p.id === Number(pollId));
    if (!poll) return { ok: false, reason: 'not_found', poll: null, choice: null };
    const before = pollSummary(poll, telegramId);
    if (poll.closedAt) return { ok: false, reason: 'closed', poll: before, choice: before.choice };
    if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) {
      return { ok: false, reason: 'invalid_option', poll: before, choice: before.choice };
    }
    if (!poll.votes || typeof poll.votes !== 'object') poll.votes = {};
    poll.votes[String(telegramId)] = index;
    const after = pollSummary(poll, telegramId);
    return { ok: true, changed: before.choice !== index, previous: before.choice, poll: after, choice: index };
  });
}

function getPoll(pollId) {
  const poll = pollTable(readDatabase()).find((p) => p.id === Number(pollId));
  return poll ? pollSummary(poll) : null;
}

// Open polls first, each group newest first.
function listPolls(limit = 20) {
  return [...pollTable(readDatabase())]
    .sort((a, b) => {
      if (Boolean(a.closedAt) !== Boolean(b.closedAt)) return a.closedAt ? 1 : -1;
      return b.id - a.id;
    })
    .slice(0, Math.max(1, Number(limit) || 20))
    .map((poll) => pollSummary(poll));
}

// Ends voting. Null when the poll does not exist or is already closed.
function closePoll(pollId, closedBy = '') {
  return mutateDatabase((database) => {
    const poll = pollTable(database).find((p) => p.id === Number(pollId));
    if (!poll || poll.closedAt) return null;
    poll.closedAt = new Date().toISOString();
    poll.closedBy = String(closedBy);
    const summary = pollSummary(poll);
    pruneClosedPolls(database);
    return summary;
  });
}

// How many users the poll message reached (set by the bot after sending).
function setPollSent(pollId, sent) {
  return mutateDatabase((database) => {
    const poll = pollTable(database).find((p) => p.id === Number(pollId));
    if (!poll) return null;
    poll.sent = Math.max(0, Math.floor(Number(sent) || 0));
    return pollSummary(poll);
  });
}

// ---------- Recent prompts (Admin Panel -> Recent Prompts) ----------
// Written by server.js only while the admin has the feature ON (admin-settings promptLogEnabled).
// Kept in its own file next to the main database: prompt text does not bloat the database that
// is rewritten on every request, is not copied into its .bak, and can be wiped in one go.
// file = { users: { <telegramId>: [ { at, lastAt, model, endpoint, status, text, chars, repeats } ] } }
// Newest first per user. A prompt equal to the user's latest one (coding agents resend the same
// question with every tool call) bumps `repeats` instead of taking another slot.
const promptLogPath = path.join(path.dirname(databasePath), 'prompts.json');
const MAX_PROMPTS_PER_USER = 10;
const MAX_PROMPT_CHARS = 1000;
const MAX_PROMPT_USERS = 200; // the least recently active users beyond this are dropped
const PROMPT_PREVIEW_CHARS = 200;

// Cuts to `max` characters without splitting an emoji (a UTF-16 surrogate pair) in half.
function clipText(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function readPromptLog() {
  try {
    const log = JSON.parse(fs.readFileSync(promptLogPath, 'utf8'));
    if (log && log.users && typeof log.users === 'object' && !Array.isArray(log.users)) return log;
  } catch (error) {
    // A damaged file only holds disposable recent prompts: start over instead of blocking recording.
    if (error.code !== 'ENOENT') console.error('[prompts] unreadable prompts.json, starting a new one:', error.message);
  }
  return { users: {} };
}

// Locked, atomic read-modify-write of a small JSON side file (prompts.json, moderation.json).
function mutateLockedJson(filePath, read, mutator) {
  return withFileLock(`${filePath}.lock`, `${path.basename(filePath)} is busy; try again`, () => {
    const data = read();
    const result = mutator(data);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data), 'utf8');
    fs.renameSync(temporaryPath, filePath);
    return result;
  });
}

function mutatePromptLog(mutator) {
  return mutateLockedJson(promptLogPath, readPromptLog, mutator);
}

function lastPromptActivity(list) {
  return String(list[0]?.lastAt || list[0]?.at || '');
}

// Saves one prompt for the user. `entry` = { text, model, endpoint, status }.
function recordPrompt(telegramId, entry = {}) {
  const id = String(telegramId || '').trim();
  const raw = String(entry.text || '').trim();
  if (!id || !raw) return null;
  const text = clipText(raw, MAX_PROMPT_CHARS);
  const now = new Date().toISOString();
  return mutatePromptLog((log) => {
    const list = Array.isArray(log.users[id]) ? log.users[id] : [];
    const latest = list[0];
    if (latest && latest.text === text && latest.chars === raw.length) {
      latest.repeats = Number(latest.repeats || 1) + 1;
      latest.lastAt = now;
      latest.model = String(entry.model || latest.model || '');
      latest.status = Number(entry.status) || latest.status || 0;
    } else {
      list.unshift({
        at: now,
        lastAt: now,
        model: String(entry.model || ''),
        endpoint: String(entry.endpoint || ''),
        status: Number(entry.status) || 0,
        text,
        chars: raw.length,
        repeats: 1,
      });
    }
    log.users[id] = list.slice(0, MAX_PROMPTS_PER_USER);
    const ids = Object.keys(log.users);
    if (ids.length > MAX_PROMPT_USERS) {
      ids.sort((a, b) => lastPromptActivity(log.users[b]).localeCompare(lastPromptActivity(log.users[a])));
      for (const stale of ids.slice(MAX_PROMPT_USERS)) delete log.users[stale];
    }
    return log.users[id][0];
  });
}

// Users with stored prompts, most recently active first, with their names from the main
// database. `latestText` is a preview of the newest prompt.
function listPromptUsers() {
  const log = readPromptLog();
  const users = readDatabase().users || {};
  return Object.entries(log.users)
    .filter(([, list]) => Array.isArray(list) && list.length)
    .map(([id, list]) => ({
      telegramId: id,
      firstName: users[id]?.firstName || '',
      username: users[id]?.username || '',
      count: list.length,
      lastAt: lastPromptActivity(list),
      latestText: clipText(String(list[0].text || ''), PROMPT_PREVIEW_CHARS),
      latestModel: list[0].model || '',
    }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// One user's stored prompts (newest first), or null when there are none.
function getUserPrompts(telegramId) {
  const id = String(telegramId || '').trim();
  const stored = readPromptLog().users;
  const list = Object.prototype.hasOwnProperty.call(stored, id) ? stored[id] : null;
  if (!Array.isArray(list) || !list.length) return null;
  const user = readDatabase().users?.[id];
  return { telegramId: id, firstName: user?.firstName || '', username: user?.username || '', prompts: list };
}

// Deletes one user's stored prompts. Returns how many were removed.
function clearPrompts(telegramId) {
  const id = String(telegramId ?? '').trim();
  if (!id || !fs.existsSync(promptLogPath)) return 0;
  return mutatePromptLog((log) => {
    if (!Object.prototype.hasOwnProperty.call(log.users, id)) return 0;
    const removed = Array.isArray(log.users[id]) ? log.users[id].length : 0;
    delete log.users[id];
    return removed;
  });
}

// Deletes every stored prompt. Returns how many were removed.
function clearAllPrompts() {
  if (!fs.existsSync(promptLogPath)) return 0;
  return mutatePromptLog((log) => {
    const removed = Object.values(log.users).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    log.users = {};
    return removed;
  });
}

// ---------- AI moderation log (Admin Panel -> Moderation) ----------
// Written by server.js: one entry per prompt the moderator rejected, plus running counters.
// file = { blocked: [ { id, at, telegramId, model, endpoint, category, reason, text, chars } ],
//          stats: { since, checked, blocked, errors, lastError, lastErrorAt } }   (newest first)
const moderationLogPath = path.join(path.dirname(databasePath), 'moderation.json');
const MAX_MODERATION_ENTRIES = 100;
const MAX_MODERATION_TEXT = 2000;

function emptyModerationStats() {
  return { since: new Date().toISOString(), checked: 0, blocked: 0, errors: 0, lastError: '', lastErrorAt: null };
}

function readModerationLog() {
  try {
    const log = JSON.parse(fs.readFileSync(moderationLogPath, 'utf8'));
    if (log && Array.isArray(log.blocked)) {
      log.stats = { ...emptyModerationStats(), ...(log.stats && typeof log.stats === 'object' ? log.stats : {}) };
      return log;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[moderation] unreadable moderation.json, starting a new one:', error.message);
  }
  return { blocked: [], stats: emptyModerationStats() };
}

// Saves one rejected prompt. `entry` = { telegramId, model, endpoint, category, reason, text }.
function recordModerationBlock(entry = {}) {
  const raw = String(entry.text || '').trim();
  return mutateLockedJson(moderationLogPath, readModerationLog, (log) => {
    const taken = new Set(log.blocked.map((item) => item.id));
    let id;
    do {
      id = crypto.randomBytes(4).toString('hex');
    } while (taken.has(id));
    const saved = {
      id,
      at: new Date().toISOString(),
      telegramId: String(entry.telegramId || ''),
      model: String(entry.model || ''),
      endpoint: String(entry.endpoint || ''),
      category: String(entry.category || 'other').slice(0, 40),
      reason: String(entry.reason || '').slice(0, 300),
      text: clipText(raw, MAX_MODERATION_TEXT),
      chars: raw.length,
    };
    log.blocked = [saved, ...log.blocked].slice(0, MAX_MODERATION_ENTRIES);
    log.stats.blocked = Number(log.stats.blocked || 0) + 1;
    return saved;
  });
}

// Adds to the counters. `delta` = { checked?, errors?, lastError? }.
function addModerationStats(delta = {}) {
  return mutateLockedJson(moderationLogPath, readModerationLog, (log) => {
    log.stats.checked = Number(log.stats.checked || 0) + Math.max(0, Number(delta.checked) || 0);
    log.stats.errors = Number(log.stats.errors || 0) + Math.max(0, Number(delta.errors) || 0);
    if (delta.lastError) {
      log.stats.lastError = String(delta.lastError).slice(0, 300);
      log.stats.lastErrorAt = new Date().toISOString();
    }
    return { ...log.stats };
  });
}

function withUserNames(entry, users) {
  const user = users[entry.telegramId];
  return { ...entry, firstName: user?.firstName || '', username: user?.username || '' };
}

// { stats, total, entries: newest `limit` blocked prompts with the users' names }.
function listModerationBlocks(limit = 20) {
  const log = readModerationLog();
  const users = readDatabase().users || {};
  const count = Math.max(0, Math.min(Number(limit) || 0, MAX_MODERATION_ENTRIES));
  return { stats: log.stats, total: log.blocked.length, entries: log.blocked.slice(0, count).map((entry) => withUserNames(entry, users)) };
}

// One blocked prompt by id, or null.
function getModerationBlock(id) {
  const entry = readModerationLog().blocked.find((item) => item.id === String(id || '').trim().toLowerCase());
  return entry ? withUserNames(entry, readDatabase().users || {}) : null;
}

// Deletes the stored blocked prompts and resets the counters. Returns how many were removed.
function clearModerationBlocks() {
  if (!fs.existsSync(moderationLogPath)) return 0;
  return mutateLockedJson(moderationLogPath, readModerationLog, (log) => {
    const removed = log.blocked.length;
    log.blocked = [];
    log.stats = emptyModerationStats();
    return removed;
  });
}

module.exports = { ensureUser, setUserLanguage, SUPPORTED_LANGUAGES, createApiKey, findUserByApiKey, recordUsage, getUser, getAllUsers, recordAdminRequest, getAdminLogs, addBalance, adjustBalance, getOrder, revokeApiKey, createOrder, settleOrder, createRedeemCode, redeemCode, listRedeemCodes, disableRedeemCode, normalizeRedeemCode, getAdminStats, resetStats, databasePath,
  createAccessCode, redeemAccessCode, listAccessCodes, getAccessCode, disableAccessCode, getModelAccess, modelAccessFor,
  ACCESS_CODE_PATTERN, MAX_ACCESS_MODELS, MAX_ACCESS_PERIOD_MS, MAX_ACCESS_AHEAD_MS, DEFAULT_ACCESS_REDEEM_WINDOW_MS,
  getReferralInfo, startWithReferral,
  createTicket, addTicketMessage, linkAdminMessage, findTicketByAdminMessage, getTicket, getOpenTicketForUser, listTickets, countOpenTickets, closeTicket,
  createPoll, votePoll, getPoll, listPolls, closePoll, setPollSent,
  recordPrompt, listPromptUsers, getUserPrompts, clearPrompts, clearAllPrompts, promptLogPath,
  recordModerationBlock, addModerationStats, listModerationBlocks, getModerationBlock, clearModerationBlocks, moderationLogPath,
  DatabaseBusyError, isDatabaseBusyError };

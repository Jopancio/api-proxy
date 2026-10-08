// Token credits: balances, reservations, payment orders, unlimited passes and the ledger.
//
// Storage (next to users.json, kept apart from the old Rupiah balance which is never touched):
//   data/credits.json          state: accounts, open reservations, orders, passes, recent history
//   data/credits-ledger.jsonl  append-only ledger, one JSON entry per line: purchases, usage,
//                              refunds, admin adjustments, unlimited purchases
// Every change runs under one file lock (same lock code and EDB_BUSY error as users.json), so a
// read-check-write is atomic across processes: concurrent requests can never spend the same
// credits, and a balance can never go below zero.
//
// Crash safety of the ledger: inside the lock the new ledger lines are appended first, then the
// state file is replaced atomically. Each line carries `seq`; state.seq is the last committed
// one. A line with seq > state.seq belongs to a write that never committed, and the next write
// reuses that seq, so readers keep the LAST line per seq and ignore seq > state.seq.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const rules = require('./credit-rules');
const creditConfig = require('./credit-config');
const usageDb = require('./usage-db');

const statePath = process.env.CREDIT_STATE_PATH
  ? path.resolve(__dirname, process.env.CREDIT_STATE_PATH)
  : path.join(path.dirname(usageDb.databasePath), 'credits.json');
const ledgerPath = `${statePath.replace(/\.json$/i, '')}-ledger.jsonl`;
const lockPath = `${statePath}.lock`;
const HOSTNAME = os.hostname();
// Identifies this process's reservations, so a restart can tell its own leftovers apart.
const INSTANCE = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const RECENT_PER_USER = 30;
const PASSES_KEPT_PER_USER = 20;
const OPEN_ORDER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

function randomId(prefix, bytes = 6) {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

function emptyState() {
  return { version: 1, seq: 0, createdAt: iso(), accounts: {}, reservations: {}, orders: {}, passes: {}, recent: {} };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`Credit database read failed; refusing to reset credits: ${error.message}`);
  }
  if (!isObject(state)) throw new Error('Credit database is not an object; refusing to reset credits');
  for (const key of ['accounts', 'reservations', 'orders', 'passes', 'recent']) {
    if (!isObject(state[key])) state[key] = {};
  }
  if (!Number.isSafeInteger(state.seq) || state.seq < 0) state.seq = 0;
  return state;
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state), 'utf8');
  if (fs.existsSync(statePath)) fs.copyFileSync(statePath, `${statePath}.bak`);
  fs.renameSync(temporaryPath, statePath);
}

// True when the ledger's last byte is not a newline (a line torn by a crash mid-append): the next
// append then starts on a fresh line, so the torn bytes can never swallow a committed entry.
function ledgerEndsMidLine() {
  let handle;
  try {
    handle = fs.openSync(ledgerPath, 'r');
    const size = fs.fstatSync(handle).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    fs.readSync(handle, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// Locked read-modify-write. The mutator gets (state, tx); tx.unchanged = true skips the write.
function mutateState(mutator) {
  return usageDb.withFileLock(lockPath, 'Credit database is busy; try again', () => {
    const state = readState();
    const tx = { entries: [], unchanged: false };
    const result = mutator(state, tx);
    if (tx.unchanged && !tx.entries.length) return result;
    if (tx.entries.length) {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      const lines = `${tx.entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
      fs.appendFileSync(ledgerPath, ledgerEndsMidLine() ? `\n${lines}` : lines, 'utf8');
    }
    writeState(state);
    return result;
  });
}

function newAccount() {
  const at = iso();
  return { balance: 0, reserved: 0, purchased: 0, used: 0, refunded: 0, adjusted: 0, shortfall: 0, createdAt: at, updatedAt: at };
}

function accountOf(state, telegramId) {
  const id = String(telegramId);
  if (!/^\d{1,20}$/.test(id)) throw new Error('ID user tidak valid');
  if (!isObject(state.accounts[id])) state.accounts[id] = newAccount();
  return state.accounts[id];
}

function accountView(account) {
  const balance = Math.max(0, Number(account?.balance) || 0);
  const reserved = Math.max(0, Number(account?.reserved) || 0);
  return {
    balance,
    reserved,
    available: Math.max(0, balance - reserved),
    purchased: Number(account?.purchased) || 0,
    used: Number(account?.used) || 0,
    refunded: Number(account?.refunded) || 0,
    adjusted: Number(account?.adjusted) || 0,
    shortfall: Number(account?.shortfall) || 0,
  };
}

function addLedger(state, tx, entry) {
  state.seq += 1;
  const full = { seq: state.seq, id: `${state.seq}-${crypto.randomBytes(3).toString('hex')}`, at: iso(), ...entry };
  tx.entries.push(full);
  if (full.userId) {
    const list = Array.isArray(state.recent[full.userId]) ? state.recent[full.userId] : [];
    list.push(full);
    state.recent[full.userId] = list.slice(-RECENT_PER_USER);
  }
  return full;
}

function assertAdmin(actorId, what) {
  if (!creditConfig.isCreditAdmin(actorId)) throw new Error(`Hanya admin yang bisa ${what}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// ---------- Reads (no lock: the state file is always replaced atomically) ----------

function getCreditAccount(telegramId) {
  return accountView(readState().accounts[String(telegramId)]);
}

function passStatus(pass, now = Date.now()) {
  const start = Date.parse(pass.startsAt);
  const end = Date.parse(pass.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now >= end) return 'ended';
  return now < start ? 'scheduled' : 'active';
}

function userPasses(state, telegramId) {
  const list = state.passes[String(telegramId)];
  return Array.isArray(list) ? list.filter((pass) => pass && Array.isArray(pass.models)) : [];
}

function activePassFor(passes, model, now = Date.now()) {
  const key = rules.modelKey(model);
  return passes.find((pass) => passStatus(pass, now) === 'active' && pass.models.includes(key)) || null;
}

// One read for the request gate: the credit account, the unlimited pass covering `model` (if
// any) and whether the user has any active pass at all.
function getUserBillingState(telegramId, model, now = Date.now()) {
  const state = readState();
  const passes = userPasses(state, telegramId);
  return {
    account: accountView(state.accounts[String(telegramId)]),
    pass: model ? activePassFor(passes, model, now) : null,
    hasActivePass: passes.some((pass) => passStatus(pass, now) === 'active'),
  };
}

function orderView(order) {
  return order ? { ...order } : null;
}

// Balance, unlimited passes, recent history and orders of one user (bot: Kredit Token).
function getCreditOverview(telegramId) {
  const id = String(telegramId);
  const state = readState();
  const now = Date.now();
  const passes = userPasses(state, id).map((pass) => ({ ...pass, status: passStatus(pass, now) }));
  const orders = Object.values(state.orders).filter((order) => order.userId === id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10).map(orderView);
  const legacyUser = usageDb.getUser(id);
  return {
    account: accountView(state.accounts[id]),
    reservations: Object.values(state.reservations).filter((entry) => entry.userId === id).length,
    passes: {
      active: passes.filter((pass) => pass.status === 'active'),
      scheduled: passes.filter((pass) => pass.status === 'scheduled').sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    },
    recent: (Array.isArray(state.recent[id]) ? state.recent[id] : []).slice().reverse(),
    orders,
    // The old Rupiah balance stays separate until a conversion rule is decided.
    legacy: { balance: Number(legacyUser?.balance || 0), bonusTokens: Number(legacyUser?.bonusTokens || 0) },
  };
}

function getCreditOrder(telegramId, orderId) {
  const order = readState().orders[String(orderId || '')];
  return order && (telegramId === undefined || telegramId === null || order.userId === String(telegramId)) ? orderView(order) : null;
}

function listCreditOrders({ status = '', limit = 10 } = {}) {
  const wanted = String(status || '').toUpperCase();
  return Object.values(readState().orders)
    .filter((order) => !wanted || order.status === wanted)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
    .map(orderView);
}

function getCreditStats() {
  const state = readState();
  const now = Date.now();
  const stats = {
    accounts: 0, totalBalance: 0, totalReserved: 0, purchased: 0, used: 0, refunded: 0, adjusted: 0, shortfall: 0,
    openReservations: Object.keys(state.reservations).length,
    settledOrders: 0, pendingOrders: 0, revenueIdr: 0, creditRevenueIdr: 0, unlimitedRevenueIdr: 0,
    activePasses: 0, ledgerSeq: state.seq,
  };
  for (const account of Object.values(state.accounts)) {
    const view = accountView(account);
    stats.accounts += 1;
    stats.totalBalance += view.balance;
    stats.totalReserved += view.reserved;
    stats.purchased += view.purchased;
    stats.used += view.used;
    stats.refunded += view.refunded;
    stats.adjusted += view.adjusted;
    stats.shortfall += view.shortfall;
  }
  for (const order of Object.values(state.orders)) {
    if (order.status === 'SETTLED') {
      stats.settledOrders += 1;
      stats.revenueIdr += Number(order.priceIdr || 0);
      if (order.kind === 'unlimited') stats.unlimitedRevenueIdr += Number(order.priceIdr || 0);
      else stats.creditRevenueIdr += Number(order.priceIdr || 0);
    } else if (order.status === 'PENDING') {
      stats.pendingOrders += 1;
    }
  }
  for (const list of Object.values(state.passes)) {
    for (const pass of Array.isArray(list) ? list : []) if (passStatus(pass, now) === 'active') stats.activePasses += 1;
  }
  return stats;
}

// The full ledger, filtered (newest first). Ignores lines that never committed (see top).
function readLedger({ userId = '', type = '', limit = 100 } = {}) {
  const committed = readState().seq;
  let text = '';
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const bySeq = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (Number.isSafeInteger(entry.seq) && entry.seq <= committed) bySeq.set(entry.seq, entry);
    } catch (_) { /* a torn last line from a crash */ }
  }
  return [...bySeq.values()]
    .filter((entry) => (!userId || entry.userId === String(userId)) && (!type || entry.type === type))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, Math.max(1, Number(limit) || 100));
}

// ---------- Reservations (server.js only) ----------

// Atomically reserves credits for one request. `planner(available)` runs INSIDE the lock with
// the credits not yet reserved by other requests and returns either { reject: true, needed } or
// { credits, ...details }. The planner decides how much (estimate input + output limit), the
// lock guarantees nobody else spends those credits meanwhile.
function reserveCredits(telegramId, planner, meta = {}) {
  return mutateState((state, tx) => {
    const account = accountOf(state, telegramId);
    const available = Math.max(0, account.balance - account.reserved);
    const plan = planner(available);
    if (!plan || plan.reject) {
      tx.unchanged = true;
      return { ok: false, available, needed: plan?.needed ?? null };
    }
    const credits = Number(plan.credits);
    if (!Number.isSafeInteger(credits) || credits < 0 || credits > available) {
      tx.unchanged = true;
      return { ok: false, available, needed: Number.isSafeInteger(credits) ? credits : null };
    }
    const id = randomId('rsv_');
    const reservation = {
      id,
      userId: String(telegramId),
      credits,
      snapshot: meta.snapshot,
      estimate: plan.estimate || {},
      endpoint: String(meta.endpoint || ''),
      createdAt: iso(),
      host: HOSTNAME,
      pid: process.pid,
      instance: INSTANCE,
    };
    state.reservations[id] = reservation;
    account.reserved += credits;
    account.updatedAt = reservation.createdAt;
    return { ok: true, reservation, available, plan };
  });
}

// Charges a reservation with the usage that really happened, ONCE: the reservation is deleted
// in the same write, so a second call finds nothing and charges nothing. Uses the reservation's
// rate snapshot, never the current configuration. The charge is capped at the credits this
// request can still take (balance minus other requests' reservations), so the balance never
// goes negative; what could not be collected is recorded as `shortfall`.
function settleLocked(state, tx, reservation, outcome = {}) {
  const account = accountOf(state, reservation.userId);
  const snapshot = reservation.snapshot;
  const counts = {
    inputTokens: Math.max(0, Math.floor(Number(outcome.counts?.inputTokens) || 0)),
    cachedInputTokens: Math.max(0, Math.floor(Number(outcome.counts?.cachedInputTokens) || 0)),
    outputTokens: Math.max(0, Math.floor(Number(outcome.counts?.outputTokens) || 0)),
    reasoningTokens: Math.max(0, Math.floor(Number(outcome.counts?.reasoningTokens) || 0)),
    toolCalls: Math.max(0, Math.floor(Number(outcome.counts?.toolCalls) || 0)),
  };
  const computed = rules.computeCredits(snapshot.units, counts, snapshot.toolCallCredits);
  const otherReserved = Math.max(0, account.reserved - reservation.credits);
  const chargeable = Math.max(0, account.balance - otherReserved);
  const charged = Math.min(computed, chargeable);
  const shortfall = computed - charged;
  account.balance -= charged;
  account.reserved = otherReserved;
  account.used += charged;
  account.shortfall = (Number(account.shortfall) || 0) + shortfall;
  account.updatedAt = iso();
  delete state.reservations[reservation.id];
  let entry = null;
  if (computed > 0) {
    entry = addLedger(state, tx, {
      type: 'usage',
      userId: reservation.userId,
      credits: -charged,
      balanceAfter: account.balance,
      model: snapshot.requestedModel,
      provider: snapshot.provider,
      routedTo: snapshot.routedTo || null,
      rateModel: snapshot.rateModel,
      multiplier: snapshot.multiplier,
      ...(snapshot.units.input !== snapshot.units.output || snapshot.units.cachedInput !== snapshot.units.input
        ? { rates: { input: rules.formatMultiplier(snapshot.units.input), cachedInput: rules.formatMultiplier(snapshot.units.cachedInput), output: rules.formatMultiplier(snapshot.units.output) } }
        : {}),
      configVersion: snapshot.configVersion,
      ...counts,
      computedCredits: computed,
      charged,
      ...(shortfall ? { shortfall } : {}),
      reservedCredits: reservation.credits,
      reservationId: reservation.id,
      status: Number(outcome.status) || 0,
      endpoint: reservation.endpoint,
      ...(outcome.upstreamModel ? { upstreamModel: String(outcome.upstreamModel).slice(0, 100) } : {}),
      ...(outcome.estimated ? { estimated: true } : {}),
      ...(outcome.partial ? { partial: true } : {}),
      ...(outcome.reason ? { reason: String(outcome.reason).slice(0, 60) } : {}),
    });
  }
  return {
    ok: true,
    charged,
    computed,
    shortfall,
    balance: account.balance,
    available: Math.max(0, account.balance - account.reserved),
    multiplier: snapshot.multiplier,
    rateModel: snapshot.rateModel,
    ledgerSeq: entry ? entry.seq : null,
  };
}

function settleReservation(reservationId, outcome = {}) {
  return mutateState((state, tx) => {
    const reservation = state.reservations[String(reservationId || '')];
    if (!reservation) {
      tx.unchanged = true;
      return { ok: false, alreadySettled: true, charged: 0 };
    }
    return settleLocked(state, tx, reservation, outcome);
  });
}

// Gives the whole reservation back (nothing was used: upstream failed before any usage).
function releaseReservation(reservationId, reason = '') {
  return mutateState((state, tx) => {
    const reservation = state.reservations[String(reservationId || '')];
    if (!reservation) {
      tx.unchanged = true;
      return { ok: false, alreadySettled: true };
    }
    const account = accountOf(state, reservation.userId);
    account.reserved = Math.max(0, account.reserved - reservation.credits);
    account.updatedAt = iso();
    delete state.reservations[reservation.id];
    if (reason) console.log(`[credits] released ${reservation.credits} credits of ${reservation.id} (${reason})`);
    return { ok: true, released: reservation.credits, available: Math.max(0, account.balance - account.reserved) };
  });
}

// Reservations left behind by a process that died (restart, crash) or older than the TTL.
// Policy (credit-config limits.orphanPolicy, documented in README): 'charge_input_estimate'
// bills the input estimate taken when the request started (output unknown, so 0) and marks it
// estimated; 'release' gives everything back.
function sweepReservations(now = Date.now()) {
  const config = creditConfig.getCreditConfig();
  const ttlMs = config.limits.reservationTtlMinutes * 60 * 1000;
  const stale = (reservation) => {
    if (now - Date.parse(reservation.createdAt) > ttlMs) return true;
    if (reservation.host !== HOSTNAME) return false;
    if (reservation.pid === process.pid) return reservation.instance !== INSTANCE;
    return !processIsAlive(reservation.pid);
  };
  const preview = Object.values(readState().reservations).filter(stale);
  if (!preview.length) return { swept: 0, charged: 0 };
  return mutateState((state, tx) => {
    let swept = 0;
    let charged = 0;
    for (const reservation of Object.values(state.reservations)) {
      if (!stale(reservation)) continue;
      swept += 1;
      if (config.limits.orphanPolicy === 'release') {
        const account = accountOf(state, reservation.userId);
        account.reserved = Math.max(0, account.reserved - reservation.credits);
        delete state.reservations[reservation.id];
        continue;
      }
      const result = settleLocked(state, tx, reservation, {
        counts: { inputTokens: reservation.estimate?.inputTokens || 0 },
        estimated: true,
        reason: 'orphaned_reservation',
      });
      charged += result.charged;
    }
    if (swept) console.warn(`[credits] swept ${swept} abandoned reservation(s), charged ${charged} credits (policy ${config.limits.orphanPolicy})`);
    return { swept, charged };
  });
}

// ---------- Orders and payments ----------

// Creates a PENDING order BEFORE the payment is requested, with price and content taken from the
// server's configuration (never from the caller). Throws a readable reason when it cannot be sold.
function createCreditOrder(telegramId, request = {}) {
  const id = String(telegramId);
  if (!/^\d{1,20}$/.test(id)) throw new Error('ID user tidak valid');
  const config = creditConfig.getCreditConfig();
  const at = iso();
  let order;
  if (request.kind === 'credits') {
    if (!config.billing.creditSalesEnabled) throw new Error('Penjualan kredit sedang ditutup');
    const pkg = config.packages.find((item) => item.id === String(request.packageId || '').toLowerCase());
    if (!pkg || !pkg.active) throw new Error('Paket kredit tidak tersedia');
    order = {
      orderId: `KR-${id}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      userId: id, kind: 'credits', packageId: pkg.id, credits: pkg.credits, priceIdr: pkg.priceIdr,
    };
  } else if (request.kind === 'unlimited') {
    const unlimited = config.unlimited;
    const duration = unlimited.durations.find((item) => item.hours === Number(request.hours));
    if (!unlimited.saleEnabled || !duration || !duration.active || duration.priceIdr === null) throw new Error('Paket unlimited ini belum dijual');
    if (!unlimited.models.length) throw new Error('Daftar model paket unlimited masih kosong');
    order = {
      orderId: `UL-${id}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      userId: id, kind: 'unlimited', name: unlimited.name, hours: duration.hours, priceIdr: duration.priceIdr,
      models: [...unlimited.models], limits: { ...unlimited.limits },
    };
  } else {
    throw new Error('Jenis order tidak dikenal');
  }
  Object.assign(order, { configVersion: config.version, status: 'PENDING', createdAt: at, provider: 'CASHI' });
  return mutateState((state) => {
    accountOf(state, id);
    // Old orders that were never paid are dropped after 30 days; paid ones are kept.
    for (const [orderId, entry] of Object.entries(state.orders)) {
      if (entry.status !== 'SETTLED' && Date.now() - Date.parse(entry.createdAt) > OPEN_ORDER_KEEP_MS) delete state.orders[orderId];
    }
    state.orders[order.orderId] = order;
    return orderView(order);
  });
}

// The payment request itself failed (no payment can exist for this order).
function markCreditOrderFailed(orderId, reason = '') {
  return mutateState((state, tx) => {
    const order = state.orders[String(orderId || '')];
    if (!order || order.status !== 'PENDING') {
      tx.unchanged = true;
      return null;
    }
    order.status = 'FAILED';
    order.failedAt = iso();
    order.failReason = String(reason).slice(0, 200);
    return orderView(order);
  });
}

function createPass(state, order, now) {
  const list = userPasses(state, order.userId);
  const latestEnd = list.reduce((max, pass) => Math.max(max, Date.parse(pass.endsAt) || 0), now);
  const start = Math.max(now, latestEnd); // a second pass starts when the current one ends
  const pass = {
    id: randomId('ul_', 4),
    orderId: order.orderId,
    name: order.name,
    hours: order.hours,
    startsAt: iso(start),
    endsAt: iso(start + order.hours * HOUR_MS),
    models: [...order.models],
    limits: { ...order.limits },
    createdAt: iso(now),
  };
  const kept = list.filter((item) => passStatus(item, now) !== 'ended')
    .concat(list.filter((item) => passStatus(item, now) === 'ended').slice(-PASSES_KEPT_PER_USER));
  state.passes[order.userId] = [...kept, pass];
  return pass;
}

function applyPayment(state, tx, order, paidAmount, meta) {
  const now = Date.now();
  const account = accountOf(state, order.userId);
  let entry;
  let pass = null;
  if (order.kind === 'credits') {
    account.balance += order.credits;
    account.purchased += order.credits;
    account.updatedAt = iso(now);
    entry = addLedger(state, tx, {
      type: 'purchase', userId: order.userId, credits: order.credits, balanceAfter: account.balance,
      orderId: order.orderId, packageId: order.packageId, priceIdr: order.priceIdr, paidAmount, source: meta.source || '',
      ...(meta.confirmedBy ? { confirmedBy: meta.confirmedBy } : {}),
    });
  } else {
    pass = createPass(state, order, now);
    entry = addLedger(state, tx, {
      type: 'unlimited_purchase', userId: order.userId, credits: 0, balanceAfter: account.balance,
      orderId: order.orderId, hours: order.hours, startsAt: pass.startsAt, endsAt: pass.endsAt, models: pass.models,
      priceIdr: order.priceIdr, paidAmount, source: meta.source || '',
      ...(meta.confirmedBy ? { confirmedBy: meta.confirmedBy } : {}),
    });
  }
  order.status = 'SETTLED';
  order.settledAt = iso(now);
  order.paidAmount = paidAmount;
  order.settledBy = meta.source || '';
  order.ledgerSeq = entry.seq;
  if (meta.confirmedBy) order.confirmedBy = meta.confirmedBy;
  return { settled: true, kind: order.kind, orderId: order.orderId, userId: order.userId, credits: order.kind === 'credits' ? order.credits : 0, balance: account.balance, pass };
}

// Payment confirmation (Cashi webhook, or the bot after asking Cashi for the status).
// Credit / unlimited orders: credited ONCE (a repeated webhook finds the order SETTLED), only for
// status SETTLED and a paid amount at least the order price. Any other order id goes to the old
// Rupiah top-up (usage-db.js settleOrder), unchanged.
function settlePayment(orderId, amount, status = 'SETTLED', meta = {}) {
  const id = String(orderId || '');
  if (!readState().orders[id]) return usageDb.settleOrder(id, amount);
  return mutateState((state, tx) => {
    const order = state.orders[id];
    if (order.status === 'SETTLED') {
      tx.unchanged = true;
      return { settled: false, alreadySettled: true, kind: order.kind, orderId: id, userId: order.userId, balance: accountView(state.accounts[order.userId]).balance };
    }
    if (String(status || '').toUpperCase() !== 'SETTLED') {
      tx.unchanged = true;
      return { settled: false, reason: 'not_settled', status: String(status || ''), orderId: id, userId: order.userId };
    }
    const paid = amount === undefined || amount === null || amount === '' ? NaN : Number(amount);
    if (!Number.isFinite(paid) || paid < order.priceIdr) {
      order.lastRejectedAt = iso();
      order.lastRejectedAmount = Number.isFinite(paid) ? paid : null;
      console.warn(`[credits] payment for ${id} NOT credited: paid ${Number.isFinite(paid) ? paid : 'unknown'}, price ${order.priceIdr}`);
      return { settled: false, reason: Number.isFinite(paid) ? 'amount_mismatch' : 'amount_missing', orderId: id, userId: order.userId, expected: order.priceIdr };
    }
    return applyPayment(state, tx, order, paid, meta);
  });
}

// Admin: credits an order whose payment the admin verified by hand (e.g. the provider sent no amount).
function adminConfirmCreditOrder(orderId, actorId) {
  assertAdmin(actorId, 'mengonfirmasi order');
  return mutateState((state, tx) => {
    const order = state.orders[String(orderId || '')];
    if (!order) throw new Error('Order tidak ditemukan');
    if (order.status === 'SETTLED') {
      tx.unchanged = true;
      return { settled: false, alreadySettled: true, orderId: order.orderId, userId: order.userId };
    }
    return applyPayment(state, tx, order, order.priceIdr, { source: 'admin', confirmedBy: String(actorId).trim() });
  });
}

// ---------- Admin adjustments and refunds ----------

function checkAmount(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0 || Math.abs(number) > rules.MAX_CREDITS) throw new Error(`${label} tidak valid`);
  return number;
}

function adjustCredits(telegramId, delta, { actorId, reason = '' } = {}) {
  assertAdmin(actorId, 'menyesuaikan kredit');
  const value = checkAmount(delta, 'Jumlah kredit');
  return mutateState((state, tx) => {
    const account = accountOf(state, telegramId);
    const available = account.balance - account.reserved;
    if (value < 0 && -value > available) throw new Error(`Kredit tersedia hanya ${available}; tidak bisa dikurangi ${-value}`);
    account.balance += value;
    account.adjusted += value;
    account.updatedAt = iso();
    const entry = addLedger(state, tx, {
      type: 'adjustment', userId: String(telegramId), credits: value, balanceAfter: account.balance, by: String(actorId).trim(), reason: String(reason).slice(0, 200),
    });
    return { ...accountView(account), ledgerSeq: entry.seq };
  });
}

function refundCredits(telegramId, credits, { actorId, reason = '', ref = '' } = {}) {
  assertAdmin(actorId, 'melakukan refund kredit');
  const value = checkAmount(credits, 'Jumlah refund');
  if (value < 0) throw new Error('Jumlah refund harus positif');
  return mutateState((state, tx) => {
    const account = accountOf(state, telegramId);
    account.balance += value;
    account.refunded += value;
    account.updatedAt = iso();
    const entry = addLedger(state, tx, {
      type: 'refund', userId: String(telegramId), credits: value, balanceAfter: account.balance, by: String(actorId).trim(), reason: String(reason).slice(0, 200), ref: String(ref).slice(0, 80),
    });
    return { ...accountView(account), ledgerSeq: entry.seq };
  });
}

// ---------- Migration (scripts/migrate-credits.js) ----------
// Creates the credit state with an empty credit account for every existing user and records a
// snapshot of the old Rupiah balances for a later conversion decision. Never changes users.json
// and never converts anything. Running it again changes nothing.
function initializeCreditState(users = []) {
  return mutateState((state, tx) => {
    if (state.migration) {
      tx.unchanged = true;
      return { alreadyMigrated: true, migration: state.migration };
    }
    const snapshot = {};
    let created = 0;
    let totalRupiah = 0;
    let totalBonusTokens = 0;
    for (const user of users) {
      const id = String(user?.telegramId || '');
      if (!/^\d{1,20}$/.test(id)) continue;
      if (!isObject(state.accounts[id])) {
        state.accounts[id] = newAccount();
        created += 1;
      }
      const balance = Number(user.balance || 0);
      const bonusTokens = Number(user.bonusTokens || 0);
      if (balance > 0 || bonusTokens > 0) snapshot[id] = { balance, bonusTokens };
      totalRupiah += Math.max(0, balance);
      totalBonusTokens += Math.max(0, bonusTokens);
    }
    state.migration = {
      version: 1,
      at: iso(),
      users: users.length,
      accountsCreated: created,
      legacyRupiahTotal: totalRupiah,
      legacyBonusTokensTotal: totalBonusTokens,
      // The old balances stay in users.json, unchanged and usable; this is only a record.
      legacySnapshot: snapshot,
      conversion: 'none (Rupiah and credits are separate until a conversion rule is decided)',
    };
    return { alreadyMigrated: false, migration: state.migration };
  });
}

module.exports = {
  statePath, ledgerPath, INSTANCE,
  readState, getCreditAccount, getUserBillingState, getCreditOverview, getCreditOrder, listCreditOrders, getCreditStats, readLedger,
  reserveCredits, settleReservation, releaseReservation, sweepReservations,
  createCreditOrder, markCreditOrderFailed, settlePayment, adminConfirmCreditOrder,
  adjustCredits, refundCredits, passStatus, initializeCreditState,
};

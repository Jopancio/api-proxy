// Token credits: rules, store, payments and migration. Runs on an isolated temporary data
// directory (never data/). No network, no real payment, no upstream request.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN = '6957236291';
const DATA = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'credits-unit-'));
Object.assign(process.env, {
  USAGE_DB_PATH: path.join(DATA, 'users.json'),
  ADMIN_SETTINGS_PATH: path.join(DATA, 'settings.json'),
  MODEL_CACHE_PATH: path.join(DATA, 'models.json'),
  ADMIN_TELEGRAM_ID: ADMIN,
});
fs.writeFileSync(process.env.ADMIN_SETTINGS_PATH, JSON.stringify({ allModelsFree: false, moderation: { enabled: false } }));
fs.writeFileSync(process.env.MODEL_CACHE_PATH, JSON.stringify({ models: ['glm-5.2', 'deepseek-v4-flash', 'hy3'], aliases: { 'glm-5.2': 'cbcn/glm-5.2', 'deepseek-v4-flash': 'cbcn/deepseek-v4-flash', hy3: 'cbcn/hy3' } }));

const rules = require('../credit-rules');
const usageDb = require('../usage-db');
const creditConfig = require('../credit-config');
const store = require('../credit-store');

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

let nextUser = 100_000;
function newUserId() {
  nextUser += 1;
  return String(nextUser);
}

function fundedUser(credits) {
  const id = newUserId();
  usageDb.ensureUser(id, { firstName: 'Test' });
  if (credits) store.adjustCredits(id, credits, { actorId: ADMIN, reason: 'test setup' });
  return id;
}

function snapshotFor(model, provider = 'default') {
  const resolved = rules.resolveRate(creditConfig.getCreditConfig(), { model, provider });
  assert.ok(resolved.ok, resolved.reason);
  return resolved.snapshot;
}

// ---------- credit-rules ----------

test('multiplier math matches the examples and rounds up once at the end', () => {
  const config = rules.buildConfig({});
  const units = (model) => rules.resolveRate(config, { model }).snapshot.units;
  assert.equal(rules.computeCredits(units('glm-5.2'), { inputTokens: 60_000, outputTokens: 40_000 }), 175_000);
  assert.equal(rules.computeCredits(units('gpt-6-sol'), { inputTokens: 100_000 }), 200_000);
  assert.equal(rules.computeCredits(units('gpt-oss-120b-medium'), { outputTokens: 100_000 }), 50_000);
  // 1 token x1.25 = 1.25 -> 2; input 1 + output 1 at x1.25 = 2.5 -> 3 (not 2 + 2)
  assert.equal(rules.computeCredits(units('glm-5.1'), { inputTokens: 1 }), 2);
  assert.equal(rules.computeCredits(units('glm-5.1'), { inputTokens: 1, outputTokens: 1 }), 3);
  // No minimum charge: nothing used costs nothing; 3 tokens x0.5 = 1.5 -> 2.
  assert.equal(rules.computeCredits(units('gpt-oss-120b-medium'), {}), 0);
  assert.equal(rules.computeCredits(units('gpt-oss-120b-medium'), { inputTokens: 3 }), 2);
  // Fixed point: 0.75 x 3 = 2.25 exactly -> 3 (a float 0.1-style drift would not be exact).
  assert.equal(rules.computeCredits(units('gemini-3-flash'), { inputTokens: 3 }), 3);
  assert.equal(rules.computeCredits(units('gemini-3-flash'), { inputTokens: 4 }), 3);
  // Large numbers stay exact.
  assert.equal(rules.computeCredits(units('claude-sonnet-5-5-medium'), { inputTokens: 1_000_000_007 }), 2_250_000_016);
});

test('multipliers are parsed exactly and never 0', () => {
  assert.equal(rules.parseMultiplier('1.75'), 17_500);
  assert.equal(rules.parseMultiplier('1,25'), 12_500);
  assert.equal(rules.parseMultiplier(0.5), 5_000);
  assert.equal(rules.formatMultiplier(22_500), '2.25');
  assert.equal(rules.formatMultiplier(30_000), '3');
  for (const bad of ['0', '0.0000', '-1', '1.23456', 'abc', '', '1001']) {
    assert.throws(() => rules.parseMultiplier(bad), undefined, bad);
  }
});

test('usage from different providers is normalised without double counting', () => {
  // OpenAI: cached is part of prompt, reasoning part of completion.
  assert.deepEqual(rules.normalizeUsage({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 300 } }),
    { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500, reasoningTokens: 300, toolCalls: 0 });
  // Responses API.
  assert.deepEqual(rules.normalizeUsage({ input_tokens: 800, input_tokens_details: { cached_tokens: 100 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 850 }),
    { inputTokens: 800, cachedInputTokens: 100, outputTokens: 50, reasoningTokens: 20, toolCalls: 0 });
  // DeepSeek cache hit is a part of prompt_tokens.
  assert.equal(rules.normalizeUsage({ prompt_tokens: 900, completion_tokens: 10, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 300 }).cachedInputTokens, 600);
  // Anthropic: cache tokens are reported NEXT TO input_tokens, so they are added once.
  assert.deepEqual(rules.normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 90, output_tokens: 300, server_tool_use: { web_search_requests: 2 } }),
    { inputTokens: 5100, cachedInputTokens: 5000, outputTokens: 300, reasoningTokens: 0, toolCalls: 2 });
  // Reasoning reported OUTSIDE completion_tokens (total proves it) is added once.
  assert.equal(rules.normalizeUsage({ prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 400, total_tokens: 550 }).outputTokens, 450);
  // Reasoning inside completion (total = prompt + completion) is not added again.
  assert.equal(rules.normalizeUsage({ prompt_tokens: 100, completion_tokens: 450, completion_tokens_details: { reasoning_tokens: 400 }, total_tokens: 550 }).outputTokens, 450);
  // Gemini native usageMetadata: thoughts are separate from candidates.
  assert.deepEqual(rules.normalizeUsage({ promptTokenCount: 700, cachedContentTokenCount: 300, candidatesTokenCount: 80, thoughtsTokenCount: 120, totalTokenCount: 900 }),
    { inputTokens: 700, cachedInputTokens: 300, outputTokens: 200, reasoningTokens: 120, toolCalls: 0 });
  assert.equal(rules.normalizeUsage({ foo: 1 }), null);
  // Stream events merge by maximum (Anthropic message_start + message_delta).
  const merged = rules.mergeUsage(rules.normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 1 }), rules.normalizeUsage({ output_tokens: 300 }));
  assert.deepEqual(merged, { inputTokens: 60, cachedInputTokens: 50, outputTokens: 300, reasoningTokens: 0, toolCalls: 0 });
});

test('pending models, aliases and effort variants need an explicit mapping', () => {
  const config = rules.buildConfig({});
  for (const model of ['glm-5v-turbo', 'kimi-k3-1', 'claude', 'gemini-3.8-flash', 'gemini-3-flash-agent', 'gemini-pro-agent', 'glm-5.3']) {
    const resolved = rules.resolveRate(config, { model });
    assert.equal(resolved.ok, false, model);
    assert.equal(resolved.status, 'pending');
  }
  // An alias is never resolved from its name: "claude" stays pending until mapped.
  let overrides = rules.applyConfigChange({}, { op: 'setAlias', model: 'claude', target: 'claude-sonnet-4-6' }, config);
  let next = rules.buildConfig(overrides);
  assert.equal(rules.resolveRate(next, { model: 'claude' }).snapshot.multiplier, '1.5');
  assert.deepEqual(rules.resolveRate(next, { model: 'claude' }).snapshot.chain, ['claude', 'claude-sonnet-4-6']);
  // Effort mapping, explicit per effort; without it the alias target (or pending) applies.
  overrides = rules.applyConfigChange(overrides, { op: 'setEffort', model: 'gemini-3.8-flash', effort: 'high', target: 'gemini-3.8-flash-high' }, next);
  next = rules.buildConfig(overrides);
  assert.equal(rules.resolveRate(next, { model: 'gemini-3.8-flash', effort: 'high' }).snapshot.multiplier, '1.5');
  assert.equal(rules.resolveRate(next, { model: 'gemini-3.8-flash', effort: 'low' }).ok, false);
  // Agent alias: target AND tool price are required; tool calls are billed per call.
  overrides = rules.applyConfigChange(overrides, { op: 'setAlias', model: 'gemini-pro-agent', target: 'gemini-3.1-pro-low' }, next);
  next = rules.buildConfig(overrides);
  assert.equal(rules.resolveRate(next, { model: 'gemini-pro-agent' }).ok, false);
  overrides = rules.applyConfigChange(overrides, { op: 'setToolPrice', model: 'gemini-pro-agent', credits: 5000 }, next);
  next = rules.buildConfig(overrides);
  const agent = rules.resolveRate(next, { model: 'gemini-pro-agent' }).snapshot;
  assert.equal(agent.toolCallCredits, 5000);
  assert.equal(rules.computeCredits(agent.units, { inputTokens: 100, toolCalls: 2 }, agent.toolCallCredits), 150 + 10_000);
  // Loops are refused.
  overrides = rules.applyConfigChange(overrides, { op: 'setAlias', model: 'kimi-k3-1', target: 'claude' }, next);
  next = rules.buildConfig(overrides);
  assert.throws(() => rules.applyConfigChange(overrides, { op: 'setAlias', model: 'claude', target: 'kimi-k3-1' }, next), /melingkar/);
  // Multiplier 0 is refused (a paid model cannot be made free by its rate).
  assert.throws(() => rules.applyConfigChange({}, { op: 'setRate', model: 'glm-5v-turbo', multiplier: '0' }, config), /lebih dari 0/);
});

test('DeepSeek alias routing is per provider and uses the target rate (1.5)', () => {
  const config = rules.buildConfig({});
  const overrides = rules.applyConfigChange({}, { op: 'setRouting', provider: 'cbcn', model: 'deepseek-v4-flash', target: 'deepseek-v4.1-flash' }, config);
  const next = rules.buildConfig(rules.applyConfigChange(overrides, { op: 'setRouting', provider: 'cbcn', model: 'deepseek-v4-pro', target: 'deepseek-v4.1-flash' }, rules.buildConfig(overrides)));
  const at = (model, provider) => rules.resolveRate(next, { model, provider }).snapshot;
  assert.equal(at('deepseek-v4-flash', 'cbcn').multiplier, '1.5');
  assert.equal(at('deepseek-v4-flash', 'cbcn').routedTo, 'deepseek-v4.1-flash');
  assert.equal(at('deepseek-v4-pro', 'cbcn').multiplier, '1.5');
  // Another provider keeps the checkpoint rates: no routing is assumed.
  assert.equal(at('deepseek-v4-flash', '1').multiplier, '1.25');
  assert.equal(at('deepseek-v4-pro', '1').multiplier, '1.75');
  assert.equal(at('deepseek-v4-pro-0813', 'cbcn').multiplier, '1.75');
  assert.equal(rules.providerOf('cbcn/deepseek-v4-flash'), 'cbcn');
  assert.equal(rules.providerOf('deepseek-v4-flash'), 'default');
});

test('admin commands parse into validated changes', () => {
  assert.deepEqual(rules.parseAdminCommand('paket kredit-10m 10.000.000 4000'), { kind: 'config', change: { op: 'setPackage', id: 'kredit-10m', credits: 10_000_000, priceIdr: 4000 } });
  assert.deepEqual(rules.parseAdminCommand('tarif glm-5v-turbo 1,5'), { kind: 'config', change: { op: 'setRate', model: 'glm-5v-turbo', multiplier: '1,5' } });
  assert.deepEqual(rules.parseAdminCommand('route cbcn deepseek-v4-flash deepseek-v4.1-flash').change, { op: 'setRouting', provider: 'cbcn', model: 'deepseek-v4-flash', target: 'deepseek-v4.1-flash' });
  assert.deepEqual(rules.parseAdminCommand('unlimited harga 3 12rb').change, { op: 'setUnlimitedPrice', hours: 3, priceIdr: 12_000 });
  assert.deepEqual(rules.parseAdminCommand('kredit 123 -1jt koreksi saldo'), { kind: 'adjust', userId: '123', amount: -1_000_000, reason: 'koreksi saldo' });
  assert.equal(rules.parseAdminCommand('kredit 123 1000').error.includes('+ atau -'), true);
  assert.equal(rules.parseAdminCommand('order KR-1-2-ABC konfirmasi').kind, 'confirmOrder');
  assert.ok(rules.parseAdminCommand('hapus semua').error);
  // Unlimited cannot go on sale without a price and a model list.
  const config = rules.buildConfig({});
  assert.throws(() => rules.applyConfigChange({}, { op: 'setUnlimitedSale', enabled: true }, config), /harga/);
  assert.throws(() => rules.applyConfigChange({}, { op: 'setUnlimitedDuration', hours: 1, active: true }, config), /harga/);
  assert.equal(config.unlimited.durations.every((item) => item.priceIdr === null && !item.active), true);
  assert.deepEqual(config.unlimited.models, []);
});

// ---------- credit-config ----------

test('config changes are admin-only, versioned and audited', () => {
  assert.throws(() => creditConfig.updateCreditConfig({ op: 'setRate', model: 'glm-5v-turbo', multiplier: '1.5' }, '1234'), /Hanya admin/);
  const before = creditConfig.getCreditConfig().version;
  const result = creditConfig.updateCreditConfig({ op: 'setPackage', id: 'kredit-10m', credits: 10_000_000, priceIdr: 4500 }, ADMIN);
  assert.equal(result.version, before + 1);
  assert.equal(creditConfig.getCreditConfig().packages.find((item) => item.id === 'kredit-10m').priceIdr, 4500);
  assert.match(creditConfig.getCreditConfigAudit(1)[0].change, /setPackage/);
  assert.equal(creditConfig.getCreditConfigAudit(1)[0].by, ADMIN);
  creditConfig.updateCreditConfig({ op: 'setPackage', id: 'kredit-10m', credits: 10_000_000, priceIdr: 4000 }, ADMIN);
});

// ---------- credit-store ----------

test('reservation refuses what is not available and settles exactly once', () => {
  const id = fundedUser(10_000);
  const snapshot = snapshotFor('glm-5.2', 'cbcn');
  const refused = store.reserveCredits(id, () => ({ credits: 10_001 }), { snapshot });
  assert.equal(refused.ok, false);
  const rejected = store.reserveCredits(id, () => ({ reject: true, needed: 99_999 }), { snapshot });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.needed, 99_999);
  const held = store.reserveCredits(id, () => ({ credits: 6_000, estimate: { inputTokens: 100 } }), { snapshot });
  assert.equal(held.ok, true);
  assert.deepEqual([store.getCreditAccount(id).reserved, store.getCreditAccount(id).available], [6_000, 4_000]);
  // A second request cannot spend the reserved credits.
  assert.equal(store.reserveCredits(id, () => ({ credits: 4_001 }), { snapshot }).ok, false);
  const settled = store.settleReservation(held.reservation.id, { counts: { inputTokens: 1_000, outputTokens: 1_000 }, status: 200 });
  assert.equal(settled.charged, 3_500);
  const again = store.settleReservation(held.reservation.id, { counts: { inputTokens: 1_000, outputTokens: 1_000 }, status: 200 });
  assert.equal(again.alreadySettled, true);
  assert.deepEqual(store.getCreditAccount(id), { ...store.getCreditAccount(id), balance: 6_500, reserved: 0, available: 6_500, used: 3_500 });
  const usage = store.readLedger({ userId: id, type: 'usage' });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].multiplier, '1.75');
  assert.equal(usage[0].charged, 3_500);
});

test('usage beyond the balance is capped (never negative) and the shortfall recorded', () => {
  const id = fundedUser(1_000);
  const snapshot = snapshotFor('gpt-6-sol');
  const first = store.reserveCredits(id, () => ({ credits: 400 }), { snapshot });
  const second = store.reserveCredits(id, () => ({ credits: 500 }), { snapshot });
  // First request used far more than reserved: it may take what the second has not reserved.
  const settled = store.settleReservation(first.reservation.id, { counts: { outputTokens: 5_000 }, status: 200 });
  assert.equal(settled.computed, 10_000);
  assert.equal(settled.charged, 500);
  assert.equal(settled.shortfall, 9_500);
  assert.deepEqual([store.getCreditAccount(id).balance, store.getCreditAccount(id).reserved], [500, 500]);
  const secondSettled = store.settleReservation(second.reservation.id, { counts: { outputTokens: 100 }, status: 200 });
  assert.equal(secondSettled.charged, 200);
  assert.equal(store.getCreditAccount(id).balance, 300);
  assert.ok(store.getCreditAccount(id).balance >= 0);
});

test('a rate change while a request runs does not change its bill (snapshot)', () => {
  const id = fundedUser(100_000);
  const held = store.reserveCredits(id, () => ({ credits: 10_000 }), { snapshot: snapshotFor('hy3', 'cbcn') });
  creditConfig.updateCreditConfig({ op: 'setRate', model: 'hy3', multiplier: '5' }, ADMIN);
  try {
    const settled = store.settleReservation(held.reservation.id, { counts: { inputTokens: 1_000 }, status: 200 });
    assert.equal(settled.charged, 1_000);
    assert.equal(settled.multiplier, '1');
    assert.equal(snapshotFor('hy3', 'cbcn').multiplier, '5');
  } finally {
    creditConfig.updateCreditConfig({ op: 'setRate', model: 'hy3', multiplier: '1' }, ADMIN);
  }
});

test('concurrent reservations from several processes never spend the same credits', async () => {
  const id = fundedUser(1_000);
  const worker = `
    const store = require(${JSON.stringify(path.join(ROOT, 'credit-store.js'))});
    const rules = require(${JSON.stringify(path.join(ROOT, 'credit-rules.js'))});
    const cfg = require(${JSON.stringify(path.join(ROOT, 'credit-config.js'))});
    const snapshot = rules.resolveRate(cfg.getCreditConfig(), { model: 'hy3' }).snapshot;
    let ok = 0;
    for (let i = 0; i < 20; i += 1) {
      try { if (store.reserveCredits(${JSON.stringify(id)}, () => ({ credits: 100 }), { snapshot }).ok) ok += 1; }
      catch (error) { if (error.code !== 'EDB_BUSY') throw error; }
    }
    process.stdout.write(String(ok));`;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve(Number(out)) : reject(new Error(err))));
  }));
  const granted = (await Promise.all(runs)).reduce((sum, value) => sum + value, 0);
  const account = store.getCreditAccount(id);
  assert.equal(granted, 10);
  assert.equal(account.reserved, 1_000);
  assert.equal(account.available, 0);
  const held = Object.values(store.readState().reservations).filter((entry) => entry.userId === id);
  assert.equal(held.length, 10);
  for (const reservation of held) store.releaseReservation(reservation.id, 'test cleanup');
  assert.deepEqual([store.getCreditAccount(id).reserved, store.getCreditAccount(id).balance], [0, 1_000]);
});

test('abandoned reservations are swept with the documented policy', () => {
  const id = fundedUser(50_000);
  const held = store.reserveCredits(id, () => ({ credits: 20_000, estimate: { inputTokens: 4_000 } }), { snapshot: snapshotFor('glm-5.2', 'cbcn') });
  // Pretend it belongs to a server process that died.
  const state = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  state.reservations[held.reservation.id].pid = 2_147_483_000;
  state.reservations[held.reservation.id].instance = 'dead';
  fs.writeFileSync(store.statePath, JSON.stringify(state));
  const swept = store.sweepReservations();
  assert.equal(swept.swept, 1);
  assert.equal(swept.charged, 7_000); // input estimate 4000 x1.75, output unknown
  const entry = store.readLedger({ userId: id, type: 'usage' })[0];
  assert.equal(entry.estimated, true);
  assert.equal(entry.reason, 'orphaned_reservation');
  assert.deepEqual([store.getCreditAccount(id).balance, store.getCreditAccount(id).reserved], [43_000, 0]);
});

test('payments: credited once, amount validated, legacy top-up unchanged', () => {
  const id = fundedUser(0);
  const order = store.createCreditOrder(id, { kind: 'credits', packageId: 'kredit-25m' });
  assert.equal(order.priceIdr, 8_000);
  assert.equal(order.credits, 25_000_000);
  assert.equal(store.settlePayment(order.orderId, 7_999, 'SETTLED').reason, 'amount_mismatch');
  assert.equal(store.settlePayment(order.orderId, undefined, 'SETTLED').reason, 'amount_missing');
  assert.equal(store.settlePayment(order.orderId, 8_000, 'PENDING').reason, 'not_settled');
  assert.equal(store.getCreditAccount(id).balance, 0);
  assert.equal(store.settlePayment(order.orderId, '8000', 'SETTLED').settled, true);
  assert.equal(store.settlePayment(order.orderId, 8_000, 'SETTLED').alreadySettled, true);
  assert.equal(store.getCreditAccount(id).balance, 25_000_000);
  assert.equal(store.readLedger({ userId: id, type: 'purchase' }).length, 1);
  assert.throws(() => store.createCreditOrder(id, { kind: 'credits', packageId: 'nope' }), /tidak tersedia/);
  assert.throws(() => store.createCreditOrder(id, { kind: 'unlimited', hours: 1 }), /belum dijual/);
  // Old Rupiah order: still credited to the Rupiah balance, once; underpayment refused.
  usageDb.createOrder(id, { orderId: `TG-${id}-1`, amount: 10_000 });
  assert.equal(store.settlePayment(`TG-${id}-1`, 9_000).reason, 'amount_mismatch');
  assert.equal(store.settlePayment(`TG-${id}-1`, 10_000).settled, true);
  assert.equal(store.settlePayment(`TG-${id}-1`, 10_000).settled, false);
  assert.equal(usageDb.getUser(id).balance, 10_000);
  assert.equal(store.getCreditAccount(id).balance, 25_000_000);
});

test('unlimited packages: sale only after configuration, passes stack, snapshot of models', () => {
  for (const change of [
    { op: 'setUnlimitedPrice', hours: 3, priceIdr: 15_000 },
    { op: 'setUnlimitedDuration', hours: 3, active: true },
    { op: 'setUnlimitedModels', action: 'add', models: ['hy3', 'glm-5.2'] },
    { op: 'setUnlimitedSale', enabled: true },
  ]) creditConfig.updateCreditConfig(change, ADMIN);
  try {
    const id = fundedUser(0);
    assert.throws(() => store.createCreditOrder(id, { kind: 'unlimited', hours: 1 }), /belum dijual/);
    const first = store.createCreditOrder(id, { kind: 'unlimited', hours: 3 });
    const second = store.createCreditOrder(id, { kind: 'unlimited', hours: 3 });
    creditConfig.updateCreditConfig({ op: 'setUnlimitedModels', action: 'remove', models: ['glm-5.2'] }, ADMIN);
    const a = store.settlePayment(first.orderId, 15_000, 'SETTLED');
    const b = store.settlePayment(second.orderId, 15_000, 'SETTLED');
    assert.equal(a.pass.endsAt, b.pass.startsAt);
    const state = store.getUserBillingState(id, 'glm-5.2');
    assert.ok(state.pass, 'model bought with the pass stays covered');
    assert.equal(store.getUserBillingState(id, 'gpt-6-sol').pass, null);
    assert.equal(store.getCreditAccount(id).balance, 0);
  } finally {
    creditConfig.updateCreditConfig({ op: 'setUnlimitedSale', enabled: false }, ADMIN);
  }
});

test('admin adjustments and refunds are admin-only and ledgered', () => {
  const id = fundedUser(1_000);
  assert.throws(() => store.adjustCredits(id, 5, { actorId: '42' }), /Hanya admin/);
  assert.throws(() => store.adjustCredits(id, -1_001, { actorId: ADMIN }), /tidak bisa dikurangi/);
  store.refundCredits(id, 250, { actorId: ADMIN, reason: 'request gagal' });
  store.adjustCredits(id, -50, { actorId: ADMIN, reason: 'koreksi' });
  assert.equal(store.getCreditAccount(id).balance, 1_200);
  const types = store.readLedger({ userId: id }).map((entry) => entry.type);
  assert.deepEqual(types, ['adjustment', 'refund', 'adjustment']);
});

test('ledger lines from a write that never committed are ignored', () => {
  const id = fundedUser(500);
  const committed = store.readState().seq;
  fs.appendFileSync(store.ledgerPath, `${JSON.stringify({ seq: committed + 1, type: 'purchase', userId: id, credits: 999 })}\n{"torn`);
  assert.equal(store.readLedger({ userId: id, type: 'purchase' }).length, 0);
  store.adjustCredits(id, 7, { actorId: ADMIN, reason: 'after crash' });
  const latest = store.readLedger({ userId: id })[0];
  assert.equal(latest.seq, committed + 1);
  assert.equal(latest.credits, 7);
});

test('migration keeps users.json untouched and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(DATA, 'migrate-'));
  const users = {
    users: {
      111: { telegramId: '111', apiKeys: [], balance: 25_000, bonusTokens: 5, orders: [], stats: {}, logs: [] },
      222: { telegramId: '222', apiKeys: [], balance: 0, orders: [], stats: {}, logs: [] },
    },
    adminLogs: [],
  };
  const usersPath = path.join(dir, 'users.json');
  fs.writeFileSync(usersPath, JSON.stringify(users));
  const before = fs.readFileSync(usersPath);
  const env = { ...process.env, USAGE_DB_PATH: usersPath, ADMIN_SETTINGS_PATH: path.join(dir, 'settings.json') };
  const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-credits.js'), ...args], { env, cwd: dir, encoding: 'utf8' });
  assert.match(run(), /Dry run/);
  assert.equal(fs.existsSync(path.join(dir, 'credits.json')), false);
  assert.match(run('--apply'), /Created 2 credit account/);
  assert.match(run('--apply'), /Already migrated/);
  assert.deepEqual(fs.readFileSync(usersPath), before);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'credits.json'), 'utf8'));
  assert.deepEqual(state.migration.legacySnapshot, { 111: { balance: 25_000, bonusTokens: 5 } });
  assert.equal(state.accounts['111'].balance, 0);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).length === 1);
});

test('no secret-looking values in the new source files', () => {
  for (const file of ['credit-rules.js', 'credit-config.js', 'credit-store.js', 'scripts/migrate-credits.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /sk-[a-z0-9]{16,}|[a-f0-9]{48,}/i, file);
  }
  assert.ok(crypto.randomBytes(1));
});

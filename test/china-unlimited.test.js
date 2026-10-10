'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'china-unlimited-'));
const ADMIN = '6957236291';
Object.assign(process.env, {
  USAGE_DB_PATH: path.join(DATA, 'users.json'),
  CREDIT_CONFIG_PATH: path.join(DATA, 'credit-config.json'),
  CREDIT_STATE_PATH: path.join(DATA, 'credits.json'),
  ADMIN_SETTINGS_PATH: path.join(DATA, 'settings.json'),
  MODEL_CACHE_PATH: path.join(DATA, 'models.json'),
  ADMIN_TELEGRAM_ID: ADMIN,
});
fs.writeFileSync(process.env.MODEL_CACHE_PATH, JSON.stringify({ models: ['deepseek-v4-flash', 'kimi-k2.6', 'glm-5.2', 'qwen-3.8-max', 'minimax-m3', 'hy3', 'glm-5v-turbo', 'gpt-6-sol', 'claude', 'gemini-3-flash'] }));
fs.writeFileSync(process.env.CREDIT_CONFIG_PATH, JSON.stringify({ rates: { 'qwen-3.8-max': { status: 'active', multiplier: '1' } } }));
const config = require('../credit-config');
const store = require('../credit-store');
const rules = require('../credit-rules');
const { buildChinaUnlimitedPlan, CHINA_PRICES, CHINA_LIMITS } = require('../scripts/configure-china-unlimited');
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('China preset selects ready listed Chinese models and excludes foreign routing', () => {
  const catalog = config.getCreditCatalog();
  const plan = buildChinaUnlimitedPlan(catalog);
  assert.deepEqual(plan.desired.models, ['deepseek-v4-flash', 'glm-5.2', 'hy3', 'kimi-k2.6', 'minimax-m3', 'qwen-3.8-max']);
  assert.equal(plan.changes.at(-1).op, 'setUnlimitedSale');
  assert.equal(plan.changes.at(-1).enabled, true);
  const routed = structuredClone(catalog);
  routed.models.find(entry => entry.model === 'deepseek-v4-flash').routedTo = 'gpt-6-sol';
  assert.ok(!buildChinaUnlimitedPlan(routed).desired.models.includes('deepseek-v4-flash'));
  assert.throws(() => buildChinaUnlimitedPlan({ ...catalog, models: [] }), /Tidak ada model China/);
});

test('hour and day packages can be configured without altering multipliers, and apply is idempotent', () => {
  const before = config.getCreditConfig().rates;
  const plan = buildChinaUnlimitedPlan(config.getCreditCatalog());
  for (const change of plan.changes) config.updateCreditConfig(change, ADMIN);
  const current = config.getCreditConfig();
  assert.deepEqual(current.rates, before);
  assert.deepEqual(current.unlimited.durations.map(item => [item.hours, item.priceIdr]), CHINA_PRICES);
  assert.ok(current.unlimited.durations.every(item => item.active && item.priceIdr >= 2000));
  assert.deepEqual(current.unlimited.limits, CHINA_LIMITS);
  assert.deepEqual(buildChinaUnlimitedPlan(config.getCreditCatalog()).changes, []);
  assert.equal(rules.parseAdminCommand('unlimited harga 72 29000').change.hours, 72);
  assert.equal(rules.parseAdminCommand('unlimited 168 on').change.hours, 168);
});

test('three-day and seven-day purchases keep exact periods, models and limits; repeats never extend twice', () => {
  const user = '810001';
  const first = store.createCreditOrder(user, { kind: 'unlimited', hours: 72, priceIdr: 1, models: ['gpt-6-sol'] });
  assert.equal(first.priceIdr, 29000);
  assert.ok(!first.models.includes('gpt-6-sol'));
  assert.equal(store.settlePayment(first.orderId, 28999).reason, 'amount_mismatch');
  const paid = store.settlePayment(first.orderId, 29000);
  assert.equal(Date.parse(paid.pass.endsAt) - Date.parse(paid.pass.startsAt), 72 * 3600000);
  assert.deepEqual(paid.pass.limits, CHINA_LIMITS);
  assert.equal(store.settlePayment(first.orderId, 29000).alreadySettled, true);
  const second = store.createCreditOrder(user, { kind: 'unlimited', hours: 168 });
  const week = store.settlePayment(second.orderId, 59000);
  assert.equal(week.pass.startsAt, paid.pass.endsAt);
  assert.equal(Date.parse(week.pass.endsAt) - Date.parse(week.pass.startsAt), 168 * 3600000);
  assert.ok(store.getUserBillingState(user, 'kimi-k2.6').pass);
  assert.equal(store.getUserBillingState(user, 'gpt-6-sol').pass, null);
  assert.equal(store.getCreditAccount(user).balance, 0);
  assert.equal(store.readLedger({ userId: user, type: 'unlimited_purchase' }).length, 2);
  const changed = structuredClone(config.getCreditCatalog());
  changed.unlimited.models.push('gpt-6-sol');
  const plan = buildChinaUnlimitedPlan(changed);
  assert.deepEqual(plan.changes[0], { op: 'setUnlimitedSale', enabled: false });
  assert.deepEqual(plan.changes[1], { op: 'setUnlimitedModels', action: 'remove', models: ['gpt-6-sol'] });
});

test('preset CLI preview never writes configuration', () => {
  const before = fs.readFileSync(process.env.CREDIT_CONFIG_PATH, 'utf8');
  const output = execFileSync(process.execPath, [path.join(__dirname, '../scripts/configure-china-unlimited.js')], { cwd: DATA, encoding: 'utf8', env: process.env });
  assert.match(output, /"mode": "preview"/);
  assert.equal(fs.readFileSync(process.env.CREDIT_CONFIG_PATH, 'utf8'), before);
});

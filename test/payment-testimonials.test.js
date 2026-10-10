'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-testimonials-'));
Object.assign(process.env, {
  USAGE_DB_PATH: path.join(DATA, 'users.json'),
  CREDIT_STATE_PATH: path.join(DATA, 'credits.json'),
  CREDIT_CONFIG_PATH: path.join(DATA, 'credit-config.json'),
  ADMIN_SETTINGS_PATH: path.join(DATA, 'settings.json'),
  MODEL_CACHE_PATH: path.join(DATA, 'models.json'),
  ADMIN_TELEGRAM_ID: '6957236291',
});
const helpers = require('../payment-testimonials');
const store = require('../credit-store');
const users = require('../usage-db');
const config = require('../credit-config');
const ADMIN = '6957236291';
test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

function worker(fetchImpl, now = Date.now) {
  return helpers.createPaymentTestimonialWorker({
    token: 'test-token', fetchImpl, now, logger: { log() {}, error() {} },
    sources: [store, users].map(source => ({ list: source.listPendingPaymentTestimonials, claim: source.claimPaymentTestimonial, complete: source.completePaymentTestimonial })),
  });
}
function paidOrder(userId, extra = {}) {
  users.ensureUser(userId, { firstName: 'Bobby PrivateName', username: 'private_username' });
  const order = store.createCreditOrder(userId, { kind: 'credits', packageId: 'kredit-10m' });
  store.settlePayment(order.orderId, 4078, 'SETTLED', { source: 'webhook', ...extra });
  return order;
}
const sent = messageId => Response.json({ ok: true, result: { message_id: messageId } });

test('message masks names, escapes product labels and uses actual gross paid amount', () => {
  assert.equal(helpers.maskedName({ firstName: 'Bobby PrivateName' }), 'Bo***');
  assert.equal(helpers.maskedName({ firstName: 'Bo' }), 'B***');
  assert.equal(helpers.maskedName({ firstName: 'B' }), '***');
  assert.equal(helpers.maskedName({ firstName: '😎 王小明' }), '王小***');
  assert.equal(helpers.maskedName({}), '***');
  const text = helpers.paymentTestimonialText({ status: 'SETTLED', kind: 'unlimited', hours: 72, name: '<China & Models>', priceIdr: 29000, paidAmount: 29078, orderId: 'UL-secret-user-id' }, { firstName: 'Bobby PrivateName', username: 'private_username' });
  assert.match(text, /Bo\*\*\*/);
  assert.match(text, /&lt;China &amp; Models&gt; — 3 hari/);
  assert.match(text, /Total dibayar: <b>Rp29\.078<\/b>/);
  assert.doesNotMatch(text, /PrivateName|private_username|secret-user-id|29000/);
  assert.throws(() => helpers.paymentTestimonialText({ status: 'PENDING', paidAmount: 5000 }, {}));
  assert.throws(() => helpers.paymentTestimonialText({ status: 'SETTLED' }, {}));
});

test('verified settlements queue once; rejected, manual-inferred and historical orders do not', async () => {
  users.ensureUser('820001', { firstName: 'Bobby' });
  const order = store.createCreditOrder('820001', { kind: 'credits', packageId: 'kredit-10m' });
  store.settlePayment(order.orderId, 4000, 'PENDING');
  store.settlePayment(order.orderId, undefined);
  store.settlePayment(order.orderId, 3999);
  assert.equal(store.getCreditOrder(null, order.orderId).paymentTestimonial, undefined);
  store.settlePayment(order.orderId, 4078, 'SETTLED', { source: 'webhook' });
  store.settlePayment(order.orderId, 4078, 'SETTLED', { source: 'bot_refresh' });
  assert.deepEqual(store.listPendingPaymentTestimonials(), [order.orderId]);
  const posts = [];
  const sender = worker(async (url, options) => {
    assert.ok(options.signal);
    posts.push(JSON.parse(options.body));
    return sent(11);
  });
  await Promise.all([sender.flush(), sender.flush()]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].chat_id, '@galaxy_testi');
  assert.match(posts[0].text, /Paket 10\.000\.000 Kredit Token/);
  assert.match(posts[0].text, /Rp4\.078/);
  assert.equal(store.getCreditOrder(null, order.orderId).paymentTestimonial.messageId, 11);
  await worker(async () => { throw new Error('must not resend after restart'); }).flush();
  assert.equal(store.listPendingPaymentTestimonials().length, 0);
  const manual = store.createCreditOrder('820001', { kind: 'credits', packageId: 'kredit-10m' });
  store.adminConfirmCreditOrder(manual.orderId, ADMIN);
  assert.equal(store.getCreditOrder(null, manual.orderId).paymentTestimonial, undefined);
  const state = JSON.parse(fs.readFileSync(store.statePath));
  delete state.orders[order.orderId].paymentTestimonial; // pre-feature historical settlement
  fs.writeFileSync(store.statePath, JSON.stringify(state));
  store.settlePayment(order.orderId, 4078);
  assert.equal(store.listPendingPaymentTestimonials().length, 0);
});

test('unlimited and legacy Rupiah purchases get correct products; guessed legacy amounts stay private', async () => {
  for (const change of [
    { op: 'setUnlimitedModels', action: 'add', models: ['hy3'] },
    { op: 'setUnlimitedPrice', hours: 72, priceIdr: 29000 },
    { op: 'setUnlimitedDuration', hours: 72, active: true },
    { op: 'setUnlimitedSale', enabled: true },
  ]) config.updateCreditConfig(change, ADMIN);
  users.ensureUser('820002', { firstName: 'Bobby' });
  const order = store.createCreditOrder('820002', { kind: 'unlimited', hours: 72 });
  store.settlePayment(order.orderId, 29078);
  users.createOrder('820002', { orderId: 'TG-reported', amount: 10000 });
  assert.equal(store.settlePayment('TG-reported', 10078, 'PENDING').reason, 'not_settled');
  assert.equal(users.getOrder('820002', 'TG-reported').paymentTestimonial, undefined);
  users.settleOrder('TG-reported', 10078);
  users.settleOrder('TG-reported', 10078);
  users.createOrder('820002', { orderId: 'TG-guessed', amount: 10000 });
  users.settleOrder('TG-guessed');
  assert.deepEqual(users.listPendingPaymentTestimonials(), ['TG-reported']);
  const posts = [];
  const sender = worker(async (_, options) => { posts.push(JSON.parse(options.body).text); return sent(20 + posts.length); });
  await sender.flush();
  await sender.flush();
  assert.equal(posts.length, 2);
  assert.match(posts[0], /Unlimited Model China — 3 hari/);
  assert.match(posts[1], /Top Up Saldo Rp10\.000/);
  assert.match(posts[1], /Total dibayar: <b>Rp10\.078/);
  assert.equal(users.getOrder('820002', 'TG-reported').paymentTestimonial.status, 'sent');
});

test('permission errors and flood limits retry durably without affecting the settled balance', async () => {
  const order = paidOrder('820003');
  const balance = store.getCreditAccount('820003').balance;
  let time = Date.now();
  let requests = 0;
  await worker(async () => {
    requests++;
    return Response.json({ ok: false, error_code: 403, description: 'not a member' }, { status: 403 });
  }, () => time).flush();
  let state = store.getCreditOrder(null, order.orderId).paymentTestimonial;
  assert.equal(state.status, 'pending');
  assert.ok(state.nextAttemptAt > time);
  await worker(async () => { requests++; return sent(30); }, () => time).flush();
  assert.equal(requests, 1);
  time = state.nextAttemptAt;
  await worker(async () => {
    requests++;
    return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 200 } }, { status: 429 });
  }, () => time).flush();
  state = store.getCreditOrder(null, order.orderId).paymentTestimonial;
  assert.ok(state.nextAttemptAt >= time + 201000);
  time = state.nextAttemptAt;
  await worker(async () => { requests++; return sent(31); }, () => time).flush();
  assert.equal(store.getCreditOrder(null, order.orderId).paymentTestimonial.status, 'sent');
  assert.equal(requests, 3);
  assert.equal(store.getCreditAccount('820003').balance, balance);
});

test('ambiguous timeouts and abandoned sends never auto-post a duplicate', async () => {
  const order = paidOrder('820004');
  await worker(async () => { throw new Error('socket closed after accepting message'); }).flush();
  assert.equal(store.getCreditOrder(null, order.orderId).paymentTestimonial.status, 'uncertain');
  const abandoned = paidOrder('820005');
  const now = Date.now();
  const claim = store.claimPaymentTestimonial(abandoned.orderId, now);
  assert.ok(claim);
  assert.equal(store.claimPaymentTestimonial(abandoned.orderId, now), null);
  assert.equal(store.completePaymentTestimonial(abandoned.orderId, 'wrong-claim', { status: 'sent', messageId: 32 }), false);
  await worker(async () => { throw new Error('must not retry unknown outcome'); }, () => now + 120000).flush();
  assert.equal(store.getCreditOrder(null, abandoned.orderId).paymentTestimonial.status, 'uncertain');
});

test('separate processes cannot claim the same payment notification', async () => {
  const order = paidOrder('820006');
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'const s=require("./credit-store");try{console.log(JSON.stringify(s.claimPaymentTestimonial(process.argv[1])))}catch(e){if(e.code!=="EDB_BUSY")throw e;console.log("null")}', order.orderId], { cwd: path.join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
  const claims = (await Promise.all([run(), run(), run()])).filter(Boolean);
  assert.equal(claims.length, 1);
  store.completePaymentTestimonial(order.orderId, claims[0].claim, { status: 'sent', messageId: 99 });
});

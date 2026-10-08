// End-to-end: server.js against a MOCK upstream on 127.0.0.1, with an isolated temporary data
// directory. No paid upstream request, no real payment: the Cashi webhook is signed with a
// throw-away test secret generated here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN = '6957236291';
const DATA = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'credits-e2e-'));
const WEBHOOK_SECRET = crypto.randomBytes(16).toString('hex');
Object.assign(process.env, {
  USAGE_DB_PATH: path.join(DATA, 'users.json'),
  ADMIN_SETTINGS_PATH: path.join(DATA, 'settings.json'),
  MODEL_CACHE_PATH: path.join(DATA, 'models.json'),
  ADMIN_TELEGRAM_ID: ADMIN,
});
fs.writeFileSync(process.env.ADMIN_SETTINGS_PATH, JSON.stringify({ allModelsFree: false, paymentsEnabled: true, promptLogEnabled: false, moderation: { enabled: false } }));
const ALIASES = {
  'glm-5.2': 'cbcn/glm-5.2',
  'glm-5v-turbo': 'cbcn/glm-5v-turbo',
  'gpt-6-sol': 'cbai/gpt-6-sol',
  hy3: 'cbcn/hy3',
  claude: '1/claude',
  'deepseek-v4-flash': 'cbcn/deepseek-v4-flash',
  'deepseek-v4-pro': '1/deepseek-v4-pro',
};
fs.writeFileSync(process.env.MODEL_CACHE_PATH, JSON.stringify({ models: [...Object.keys(ALIASES), 'deepseek-v4-flash-0731'], aliases: ALIASES }));

const usageDb = require('../usage-db');
const store = require('../credit-store');
const creditConfig = require('../credit-config');

// ---------- mock upstream ----------
const mock = { requests: [], held: [] };
const DEFAULT_USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 100 } };

function completion(body, usage) {
  return { id: 'cmpl-test', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], echo: body, ...(usage ? { usage } : {}) };
}

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const mode = req.headers['x-mock'] || 'json';
    const usage = req.headers['x-mock-usage'] ? JSON.parse(req.headers['x-mock-usage']) : DEFAULT_USAGE;
    mock.requests.push({ path: req.url, body, mode, authorization: req.headers.authorization });
    const sendJson = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (mode === 'json') return sendJson(200, completion(body, usage));
    if (mode === 'nousage') return sendJson(200, { ...completion(body), choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(400) } }] });
    if (mode === 'error500') return sendJson(500, { error: { message: 'upstream exploded' } });
    if (mode === 'drop') return req.socket.destroy();
    if (mode === 'hold') return mock.held.push(() => sendJson(200, completion(body, usage)));
    if (mode === 'stream' || mode === 'cut') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      for (let i = 0; i < 3; i += 1) chunk({ object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'y'.repeat(400) } }] });
      if (mode === 'cut') {
        setTimeout(() => res.socket.destroy(), 20);
        return undefined;
      }
      if (body.stream_options?.include_usage) chunk({ object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } });
      res.end('data: [DONE]\n\n');
      return undefined;
    }
    return sendJson(400, { error: { message: `unknown mock mode ${mode}` } });
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let base = '';
let server;
const serverLog = [];

test.before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: DATA, // no .env here: nothing of the real configuration is loaded
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      UPSTREAM_API_KEY: 'mock-upstream-key',
      CASHI_SECRET_KEY: WEBHOOK_SECRET,
      TELEGRAM_BOT_TOKEN: '',
      INTERNAL_API_SECRET: '',
      FORCE_STREAM_USAGE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));
  base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (!serverLog.join('').includes('listening on')) {
    if (Date.now() - started > 15_000 || server.exitCode !== null) throw new Error(`server did not start:\n${serverLog.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test.after(async () => {
  if (server && server.exitCode === null) server.kill();
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(DATA, { recursive: true, force: true });
});

let nextUser = 500_000;
function user({ credits = 0, rupiah = 0 } = {}) {
  nextUser += 1;
  const id = String(nextUser);
  const key = usageDb.createApiKey(id, { firstName: 'E2E' });
  if (credits) store.adjustCredits(id, credits, { actorId: ADMIN, reason: 'e2e setup' });
  if (rupiah) usageDb.adjustBalance(id, rupiah);
  return { id, key };
}

function call(account, body, { mode = 'json', usage, endpoint = '/v1/chat/completions' } = {}) {
  return fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${account.key}`,
      'content-type': 'application/json',
      'x-mock': mode,
      ...(usage ? { 'x-mock-usage': JSON.stringify(usage) } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(check, label, timeout = 5_000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}\n${serverLog.slice(-20).join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const settled = (id) => store.getCreditAccount(id).reserved === 0;
const lastUsage = (id) => store.readLedger({ userId: id, type: 'usage', limit: 1 })[0];
const lastLog = (id) => usageDb.getUser(id).logs.slice(-1)[0];
const msg = (text) => ({ messages: [{ role: 'user', content: text }] });

test('health endpoint answers', async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
});

test('non-streaming request: reserved, then charged exactly (input + output) x multiplier', async () => {
  const account = user({ credits: 1_000_000 });
  const response = await call(account, { model: 'glm-5.2', ...msg('hello world') });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-billing-funding'), 'credits');
  assert.equal(response.headers.get('x-credit-multiplier'), '1.75');
  await response.json();
  await waitFor(() => settled(account.id), 'settlement');
  const entry = lastUsage(account.id);
  assert.equal(entry.charged, 2_625); // (1000 + 500) x 1.75; cached 200 and reasoning 100 not added again
  assert.equal(entry.cachedInputTokens, 200);
  assert.equal(entry.reasoningTokens, 100);
  assert.equal(entry.provider, 'cbcn');
  assert.equal(store.getCreditAccount(account.id).balance, 1_000_000 - 2_625);
  const log = await waitFor(() => lastLog(account.id), 'usage log');
  assert.equal(log.funding, 'credits');
  assert.equal(log.credits, 2_625);
  assert.equal(log.multiplier, '1.75');
  assert.equal(log.cost, 0);
  assert.equal(mock.requests.at(-1).authorization, 'Bearer mock-upstream-key');
  assert.equal(mock.requests.at(-1).body.model, 'cbcn/glm-5.2');
});

test('streaming: final usage requested from upstream and billed once', async () => {
  const account = user({ credits: 1_000_000 });
  const response = await call(account, { model: 'gpt-6-sol', stream: true, ...msg('stream please') }, { mode: 'stream' });
  const text = await response.text();
  assert.match(text, /\[DONE\]/);
  assert.equal(mock.requests.at(-1).body.stream_options.include_usage, true);
  await waitFor(() => settled(account.id), 'settlement');
  assert.equal(lastUsage(account.id).charged, 1_000); // (300 + 200) x 2
  assert.equal(lastUsage(account.id).estimated, undefined);
  assert.equal(store.readLedger({ userId: account.id, type: 'usage' }).length, 1);
});

test('stream cut off without usage: billed from the text, marked partial + estimated', async () => {
  const account = user({ credits: 1_000_000 });
  const startedAt = Date.now();
  const response = await call(account, { model: 'glm-5.2', stream: true, ...msg('a'.repeat(400)) }, { mode: 'cut' });
  await response.text().catch(() => '');
  assert.ok(Date.now() - startedAt < 5_000, 'the client connection is closed, not left hanging');
  await waitFor(() => settled(account.id), 'settlement');
  const entry = lastUsage(account.id);
  assert.equal(entry.partial, true);
  assert.equal(entry.estimated, true);
  assert.ok(entry.outputTokens >= 300, `output estimate ${entry.outputTokens}`);
  assert.ok(entry.charged > 0);
});

test('successful response without usage is estimated, never free', async () => {
  const account = user({ credits: 1_000_000 });
  await (await call(account, { model: 'hy3', ...msg('b'.repeat(80)) }, { mode: 'nousage' })).json();
  await waitFor(() => settled(account.id), 'settlement');
  const entry = lastUsage(account.id);
  assert.equal(entry.estimated, true);
  assert.equal(entry.outputTokens, 100);
  assert.ok(entry.charged >= 100);
});

test('upstream failures before any usage cost nothing', async () => {
  const account = user({ credits: 50_000 });
  const failed = await call(account, { model: 'glm-5.2', ...msg('fail') }, { mode: 'error500' });
  assert.equal(failed.status, 500);
  await failed.text();
  await waitFor(() => settled(account.id), 'release after 500');
  const dropped = await call(account, { model: 'glm-5.2', ...msg('drop') }, { mode: 'drop' });
  assert.equal(dropped.status, 502);
  await dropped.text();
  await waitFor(() => settled(account.id), 'release after connection drop');
  assert.equal(store.getCreditAccount(account.id).balance, 50_000);
  assert.equal(store.readLedger({ userId: account.id, type: 'usage' }).length, 0);
});

test('insufficient credits: output limit lowered, then refused with 402', async () => {
  const rich = user({ credits: 1_000 });
  const lowered = await call(rich, { model: 'glm-5.2', max_tokens: 100_000, ...msg('hello world') }, { usage: { prompt_tokens: 3, completion_tokens: 10 } });
  assert.equal(lowered.status, 200);
  // input estimate 3 tokens +25% = 4 -> 7 credits; (1000 - 7) / 1.75 = 567 output tokens affordable
  assert.equal(lowered.headers.get('x-credit-output-limit'), '567');
  assert.equal(mock.requests.at(-1).body.max_tokens, 567);
  await lowered.json();
  const noLimit = user({ credits: 1_000 });
  await (await call(noLimit, { model: 'glm-5.2', ...msg('hello world') }, { usage: { prompt_tokens: 3, completion_tokens: 10 } })).json();
  assert.equal(mock.requests.at(-1).body.max_tokens, 567, 'a limit is set when the default reservation is not affordable');
  const poor = user({ credits: 300 });
  const before = mock.requests.length;
  const refused = await call(poor, { model: 'glm-5.2', ...msg('hello world') });
  assert.equal(refused.status, 402);
  const error = (await refused.json()).error;
  assert.equal(error.type, 'insufficient_credits');
  assert.equal(error.available_credits, 300);
  assert.equal(mock.requests.length, before, 'never forwarded');
  const nobody = user();
  const broke = await call(nobody, { model: 'glm-5.2', ...msg('x') });
  assert.equal(broke.status, 402);
  assert.equal((await broke.json()).error.type, 'insufficient_balance');
});

test('models waiting for configuration cannot be used with credits', async () => {
  const account = user({ credits: 1_000_000 });
  for (const model of ['glm-5v-turbo', 'claude']) {
    const response = await call(account, { model, ...msg('x') });
    assert.equal(response.status, 403, model);
    assert.equal((await response.json()).error.type, 'model_pending_configuration');
  }
  assert.equal(store.getCreditAccount(account.id).balance, 1_000_000);
});

test('DeepSeek alias routing applies only to the configured provider', async () => {
  creditConfig.updateCreditConfig({ op: 'setRouting', provider: 'cbcn', model: 'deepseek-v4-flash', target: 'deepseek-v4.1-flash' }, ADMIN);
  try {
    const account = user({ credits: 1_000_000 });
    const multiplier = async (model) => {
      const response = await call(account, { model, ...msg('x') }, { usage: { prompt_tokens: 100, completion_tokens: 100 } });
      await response.json();
      await waitFor(() => settled(account.id), 'settlement');
      return [response.headers.get('x-credit-multiplier'), lastUsage(account.id)];
    };
    const [flash, flashEntry] = await multiplier('deepseek-v4-flash');
    assert.equal(flash, '1.5');
    assert.equal(flashEntry.routedTo, 'deepseek-v4.1-flash');
    assert.equal(flashEntry.charged, 300);
    assert.equal((await multiplier('deepseek-v4-pro'))[0], '1.75'); // provider "1": no routing rule
    assert.equal((await multiplier('deepseek-v4-flash-0731'))[0], '1.25');
  } finally {
    creditConfig.updateCreditConfig({ op: 'setRouting', provider: 'cbcn', model: 'deepseek-v4-flash', target: null }, ADMIN);
  }
});

test('a rate change while a request is running keeps that request on the old rate', async () => {
  const account = user({ credits: 1_000_000 });
  const pending = call(account, { model: 'glm-5.2', ...msg('slow') }, { mode: 'hold' });
  await waitFor(() => mock.held.length === 1 && store.getCreditAccount(account.id).reserved > 0, 'request held upstream');
  creditConfig.updateCreditConfig({ op: 'setRate', model: 'glm-5.2', multiplier: '3' }, ADMIN);
  try {
    mock.held.shift()();
    await (await pending).json();
    await waitFor(() => settled(account.id), 'settlement');
    assert.equal(lastUsage(account.id).multiplier, '1.75');
    assert.equal(lastUsage(account.id).charged, 2_625);
    const next = await call(account, { model: 'glm-5.2', ...msg('after change') });
    assert.equal(next.headers.get('x-credit-multiplier'), '3');
    await next.json();
    await waitFor(() => settled(account.id), 'settlement');
    assert.equal(lastUsage(account.id).charged, 4_500);
  } finally {
    creditConfig.updateCreditConfig({ op: 'setRate', model: 'glm-5.2', multiplier: '1.75' }, ADMIN);
  }
});

test('concurrent requests cannot spend the same credits', async () => {
  const account = user({ credits: 2_100 });
  const usage = { prompt_tokens: 2, completion_tokens: 500 };
  const body = { model: 'hy3', max_tokens: 1_000, ...msg('hi') }; // reserves 2 + 1000 = 1002 each
  const responses = [1, 2, 3, 4].map(() => call(account, body, { mode: 'hold', usage }));
  await waitFor(() => mock.held.length === 2, 'two requests admitted');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(mock.held.length, 2);
  while (mock.held.length) mock.held.shift()();
  const statuses = (await Promise.all(responses)).map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 200, 402, 402]);
  await waitFor(() => settled(account.id), 'settlement');
  assert.equal(store.getCreditAccount(account.id).balance, 2_100 - 2 * 502);
});

test('Cashi webhook: credits once, rejects a wrong amount, old Rupiah orders unchanged', async () => {
  const account = user();
  const send = (payload) => {
    const raw = JSON.stringify(payload);
    return fetch(`${base}/webhooks/cashi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gateway-signature': crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') },
      body: raw,
    });
  };
  const order = store.createCreditOrder(account.id, { kind: 'credits', packageId: 'kredit-10m' });
  const settledEvent = (orderId, amount) => ({ event: 'PAYMENT_SETTLED', data: { status: 'SETTLED', order_id: orderId, amount } });
  assert.equal((await send(settledEvent(order.orderId, 3_999))).status, 200);
  assert.equal(store.getCreditAccount(account.id).balance, 0);
  for (let i = 0; i < 3; i += 1) assert.equal((await send(settledEvent(order.orderId, 4_000))).status, 200);
  assert.equal(store.getCreditAccount(account.id).balance, 10_000_000);
  assert.equal(store.readLedger({ userId: account.id, type: 'purchase' }).length, 1);
  const forged = await fetch(`${base}/webhooks/cashi`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-signature': 'bad' }, body: JSON.stringify(settledEvent(order.orderId, 4_000)) });
  assert.equal(forged.status, 401);
  usageDb.createOrder(account.id, { orderId: `TG-${account.id}-legacy`, amount: 25_000 });
  await send(settledEvent(`TG-${account.id}-legacy`, 25_000));
  await send(settledEvent(`TG-${account.id}-legacy`, 25_000));
  assert.equal(usageDb.getUser(account.id).balance, 25_000);
  assert.equal(store.getCreditAccount(account.id).balance, 10_000_000);
});

test('unlimited pass: covered model is not charged and limits apply; other models use credits', async () => {
  for (const change of [
    { op: 'setUnlimitedPrice', hours: 1, priceIdr: 5_000 },
    { op: 'setUnlimitedDuration', hours: 1, active: true },
    { op: 'setUnlimitedModels', action: 'add', models: ['hy3'] },
    { op: 'setUnlimitedLimit', key: 'maxOutputTokens', value: 4_096 },
    { op: 'setUnlimitedLimit', key: 'maxConcurrent', value: 1 },
    { op: 'setUnlimitedSale', enabled: true },
  ]) creditConfig.updateCreditConfig(change, ADMIN);
  try {
    const account = user({ credits: 1_000_000 });
    const order = store.createCreditOrder(account.id, { kind: 'unlimited', hours: 1 });
    assert.equal(store.settlePayment(order.orderId, 5_000, 'SETTLED').settled, true);
    const covered = await call(account, { model: 'hy3', max_tokens: 99_999, ...msg('free?') });
    assert.equal(covered.headers.get('x-billing-funding'), 'unlimited');
    assert.equal(mock.requests.at(-1).body.max_tokens, 4_096);
    await covered.json();
    assert.equal(store.getCreditAccount(account.id).balance, 1_000_000);
    assert.equal((await waitFor(() => lastLog(account.id), 'log')).funding, 'unlimited');
    const holding = call(account, { model: 'hy3', ...msg('one') }, { mode: 'hold' });
    await waitFor(() => mock.held.length === 1, 'held');
    const second = await call(account, { model: 'hy3', ...msg('two') });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.type, 'unlimited_concurrency_limit');
    mock.held.shift()();
    await (await holding).json();
    const other = await call(account, { model: 'glm-5.2', ...msg('not covered') });
    assert.equal(other.headers.get('x-billing-funding'), 'credits');
    await other.json();
    await waitFor(() => settled(account.id), 'settlement');
    assert.equal(store.getCreditAccount(account.id).balance, 1_000_000 - 2_625);
  } finally {
    creditConfig.updateCreditConfig({ op: 'setUnlimitedSale', enabled: false }, ADMIN);
  }
});

test('old Rupiah balance keeps working with the old prices when there are no credits', async () => {
  const account = user({ rupiah: 10_000 });
  const response = await call(account, { model: 'glm-5.2', ...msg('legacy') });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-billing-funding'), null);
  await response.json();
  const log = await waitFor(() => lastLog(account.id), 'log');
  assert.equal(log.funding, 'legacy');
  assert.ok(log.cost > 0);
  assert.ok(usageDb.getUser(account.id).balance < 10_000);
  assert.equal(store.readLedger({ userId: account.id }).length, 0);
  // Credits + Rupiah, model without a credit rate: the Rupiah balance pays, credits untouched.
  const both = user({ credits: 1_000, rupiah: 10_000 });
  const pendingModel = await call(both, { model: 'glm-5v-turbo', ...msg('x') });
  assert.equal(pendingModel.status, 200);
  await pendingModel.json();
  assert.equal(store.getCreditAccount(both.id).balance, 1_000);
});

test('admin request log is written again, with the paying balance', async () => {
  const logs = await waitFor(() => {
    const entries = usageDb.getAdminLogs(500);
    return entries.some((entry) => entry.funding === 'credits' && entry.credits > 0) && entries;
  }, 'admin logs');
  assert.ok(logs.some((entry) => entry.funding === 'unlimited'));
  assert.ok(logs.some((entry) => entry.funding === 'legacy'));
  assert.doesNotMatch(serverLog.join(''), /NOT saved|TypeError|ReferenceError/);
});

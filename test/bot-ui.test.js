// Bot UI for token credits, driven by test/helpers/bot-harness.js (stubbed Telegram/Cashi, local
// data mode on an isolated temporary directory). The real bot is never started.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADMIN = '6957236291';

test('credit menus, purchase, history and admin console work end to end', () => {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'credits-bot-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ allModelsFree: false, paymentsEnabled: true, moderation: { enabled: false } }));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      models: ['glm-5.2', 'glm-5v-turbo', 'gpt-oss-120b-medium', 'gpt-6-sol', 'claude', 'claude-opus-4-6-thinking', 'deepseek-v4-flash', 'hy3'],
      aliases: { 'glm-5.2': 'cbcn/glm-5.2', 'glm-5v-turbo': 'cbcn/glm-5v-turbo', 'deepseek-v4-flash': 'cbcn/deepseek-v4-flash', hy3: 'cbcn/hy3' },
    }));
    const output = execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'bot-harness.js')], {
      cwd: dir, // no .env here
      encoding: 'utf8',
      env: {
        ...process.env,
        USAGE_DB_PATH: path.join(dir, 'users.json'),
        ADMIN_SETTINGS_PATH: path.join(dir, 'settings.json'),
        MODEL_CACHE_PATH: path.join(dir, 'models.json'),
        ADMIN_TELEGRAM_ID: ADMIN,
        TELEGRAM_BOT_TOKEN: '123456:test-token',
        CASHI_API_KEY: 'test-cashi-key',
        DATA_API_URL: '',
        INTERNAL_API_SECRET: '',
        ADMIN_MINI_APP_URL: '',
        UPSTREAM_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim().split('\n').pop());
    assert.equal(result.error, null);
    const byStep = new Map();
    let step = -1;
    for (const entry of result.transcript) {
      if (entry.step !== undefined) {
        step = entry.step;
        byStep.set(step, []);
      } else if (step >= 0) {
        byStep.get(step).push(entry);
      }
    }
    const texts = (index) => byStep.get(index).filter((entry) => entry.payload?.text || entry.payload?.caption).map((entry) => entry.payload.text || entry.payload.caption).join('\n----\n');
    const buttons = (index) => byStep.get(index).flatMap((entry) => entry.payload?.reply_markup?.inline_keyboard?.flat() || []);

    for (const entry of result.transcript) {
      if (entry.payload?.text) assert.ok(entry.payload.text.length <= 4096, `message too long (${entry.payload.text.length})`);
    }
    // Welcome after the language choice shows the credit balance.
    assert.match(texts(1), /Kredit token: <b>0<\/b>/);
    // Credit main view.
    assert.match(texts(2), /KREDIT TOKEN/);
    assert.match(texts(2), /Tersedia: <b>0<\/b> kredit/);
    assert.match(texts(2), /Sedang direservasi/);
    assert.match(texts(2), /× multiplier model/);
    assert.match(texts(2), /×0,5 ≈ <b>20 jt<\/b> token/);
    // Model list: multipliers and pending models, never "Gratis".
    assert.match(texts(3), /glm-5\.2<\/code> ×1,75/);
    assert.match(texts(3), /glm-5v-turbo<\/code> ⏳ <i>menunggu konfigurasi/);
    assert.match(texts(3), /claude<\/code> ⏳ <i>alias, menunggu mapping admin/);
    for (const index of [2, 3, 6, 9]) assert.doesNotMatch(texts(index), /Gratis/i);
    assert.match(texts(4), /Belum ada transaksi kredit/);
    assert.match(texts(5), /belum dibuka/);
    // Buy view: the four packages at their configured prices.
    for (const price of ['Rp4.000', 'Rp8.000', 'Rp15.000', 'Rp28.000']) assert.match(texts(6), new RegExp(price.replace('.', '\\.')));
    assert.ok(buttons(6).some((button) => button.callback_data === 'crbuy_kredit-10m'));
    // Purchase: the server-side order price goes to Cashi; nothing credited before verification.
    assert.equal(result.cashiOrders.length, 1);
    assert.equal(result.cashiOrders[0].amount, 4000);
    assert.match(result.cashiOrders[0].order_id, /^KR-700001-/);
    assert.match(texts(7), /QR pembayaran siap/);
    assert.match(texts(8), /Pembayaran terverifikasi/);
    assert.match(texts(8), /\+<b>10\.000\.000 <i>\(10 jt\)<\/i><\/b> kredit token/);
    assert.match(texts(9), /Tersedia: <b>10\.000\.000/);
    assert.match(texts(10), /Beli paket kredit-10m \(Rp4\.000\)/);
    // Admin views are admin-only.
    assert.match(texts(11), /Access denied/);
    assert.match(texts(13), /KREDIT &amp; PAKET/);
    assert.match(texts(13), /Pendapatan: <b>Rp4\.000/);
    assert.match(texts(14), /MULTIPLIER MODEL/);
    assert.match(texts(15), /ROUTING &amp; ALIAS/);
    assert.match(texts(16), /output_default/);
    assert.match(texts(17), /harga belum ditetapkan/);
    assert.match(texts(18), /KR-700001-/);
    assert.match(texts(19), /Perintah kredit/);
    // Admin console: several lines in one message, validated, versioned; multiplier 0 refused.
    const console = texts(20);
    assert.match(console, /✅ v1: <code>setRate model=glm-5v-turbo multiplier=1\.5/);
    assert.match(console, /✅ v2: <code>setRouting provider=cbcn/);
    assert.match(console, /✅ v3: <code>setUnlimitedPrice hours=1 priceIdr=5000/);
    assert.match(console, /✅ Kredit <code>700001<\/code> \+1\.000\.000/);
    assert.match(console, /❌ <code>tarif glm-5v-turbo 0<\/code>\n {3}Multiplier harus lebih dari 0/);
    assert.match(texts(20), /disesuaikan admin: \+1\.000\.000/); // the user was told
    assert.match(texts(21), /v3 • .*<code>6957236291<\/code>\n {3}setUnlimitedPrice hours=1 priceIdr=5000/);
    assert.match(texts(22), /Kredit token<\/b>\n[├└] Tersedia: <b>11\.000\.000/);
    assert.match(texts(24), /✅ Kredit <code>700001<\/code> -500\.000 → saldo 10\.500\.000/);
    assert.match(texts(25), /Token credits/);
    assert.match(texts(26), /Kredit token<\/b>\n[├└] Tersedia: <b>10\.500\.000/);
    assert.match(texts(27), /KREDIT TOKEN/);
    assert.match(texts(28), /glm-5v-turbo<\/code> ×1,5/);
    assert.match(texts(28), /deepseek-v4-flash<\/code> ×1,5 <i>\(→ deepseek-v4\.1-flash\)<\/i>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

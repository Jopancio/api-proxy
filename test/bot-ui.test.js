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

for (const statusMode of ['documented', 'without_amount']) {
test(`credit menus, purchase, history and admin console work end to end (${statusMode})`, () => {
  const dir = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'credits-bot-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ allModelsFree: false, paymentsEnabled: true, moderation: { enabled: false } }));
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      models: ['glm-5.2', 'glm-5v-turbo', 'gpt-oss-120b-medium', 'gpt-6-sol', 'claude', 'claude-opus-4-6-thinking', 'deepseek-v4-flash', 'hy3', `glm-${'long-model-'.repeat(7)}test`],
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
        CASHI_TEST_STATUS_MODE: statusMode,
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
    const labels = new Map();
    let step = -1;
    for (const entry of result.transcript) {
      if (entry.step !== undefined) {
        step = entry.step;
        byStep.set(step, []);
        if (entry.label) labels.set(entry.label, step);
      } else if (step >= 0) {
        byStep.get(step).push(entry);
      }
    }
    const texts = (index) => byStep.get(index).filter((entry) => entry.payload?.text || entry.payload?.caption).map((entry) => entry.payload.text || entry.payload.caption).join('\n----\n');
    const buttons = (index) => byStep.get(index).flatMap((entry) => entry.payload?.reply_markup?.inline_keyboard?.flat() || []);

    for (const entry of result.transcript) {
      if (entry.payload?.text) assert.ok(entry.payload.text.length <= 4096, `message too long (${entry.payload.text.length})`);
      for (const button of entry.payload?.reply_markup?.inline_keyboard?.flat() || []) {
        if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64, 'callback exceeds Telegram limit');
      }
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
    assert.equal(result.cashiOrders.length, 4);
    for (const order of result.cashiOrders) assert.equal(order.kode_channel, 'qris_custom');
    assert.equal(result.cashiOrders[0].amount, 4000);
    assert.match(result.cashiOrders[0].order_id, /^KR-700001-/);
    assert.match(texts(7), /QR pembayaran siap/);
    assert.match(texts(8), /Pembayaran terverifikasi/);
    assert.match(texts(8), /Jumlah dibayar: <b>Rp4\.000<\/b>/);
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
    // Buying credit packages is one labelled button everywhere; no per-1M Rupiah price or
    // Rupiah top-up for a user without an old Rupiah balance.
    const buyButton = (index) => buttons(index).some((button) => button.callback_data === 'top_up' && button.text.includes('Beli Paket Token'));
    for (const index of [2, 3, 26]) assert.ok(buyButton(index), `step ${index} has no Beli Paket Token button`);
    assert.ok(!buttons(26).some((button) => button.callback_data === 'model_price'));
    assert.ok(!buttons(3).some((button) => button.callback_data === 'model_price'));
    assert.ok(!buttons(6).some((button) => button.callback_data === 'top_up_rp'));
    assert.doesNotMatch(texts(26), /\/ ?1M|<b>Balance<\/b>|Spent:/);
    // Payments closed: the buy button explains it; only the admin is told how to open it.
    assert.match(texts(30), /Pembelian paket token sedang ditutup/);
    assert.doesNotMatch(texts(30), /Enable Payments/);
    assert.match(texts(31), /Pembelian paket token sedang ditutup[\s\S]*Enable Payments/);
    assert.match(texts(27), /KREDIT TOKEN/);
    assert.match(texts(28), /glm-5v-turbo<\/code> ×1,5/);
    assert.match(texts(28), /deepseek-v4-flash<\/code> ×1,5 <i>\(→ deepseek-v4\.1-flash\)<\/i>/);
    const uiText = (label) => texts(labels.get(label));
    const uiButtons = (label) => buttons(labels.get(label));
    assert.ok(buttons(25).some(button => button.text.includes('Atur Multiplier')));
    assert.match(uiText('multiplier_list'), /MULTIPLIER MODEL/);
    assert.match(uiText('multiplier_denied'), /Access denied/);
    assert.match(uiText('multiplier_detail'), /glm-5v-turbo/);
    assert.match(uiText('multiplier_preset'), /Multiplier tersimpan: ×2/);
    assert.match(uiText('multiplier_stale'), /Konfigurasi sudah berubah/);
    assert.match(uiText('multiplier_zero'), /harus lebih dari 0/);
    assert.match(uiText('multiplier_large'), /maksimal 1000/);
    assert.match(uiText('multiplier_precision'), /maks 4 desimal/);
    assert.match(uiText('multiplier_saved'), /Multiplier tersimpan: ×1,875/);
    assert.match(uiText('multiplier_filtered'), /Pencarian: <b>deepseek-v4-flash/);
    assert.match(uiText('multiplier_routed'), /Tarif mengikuti: <code>deepseek-v4\.1-flash/);
    assert.match(uiText('multiplier_routed_saved'), /Multiplier tersimpan: ×2,5/);
    assert.match(uiText('multiplier_filter_back'), /Pencarian: <b>deepseek-v4-flash/);
    assert.match(uiText('multiplier_empty'), /Tidak ada model yang cocok/);
    assert.match(uiText('multiplier_page_next'), /halaman 2\//);
    assert.match(uiText('multiplier_page_back'), /halaman 1\//);
    assert.match(uiText('multiplier_alias'), /Atur mapping alias terlebih dahulu/);
    assert.ok(!uiButtons('multiplier_alias').some(button => button.callback_data?.startsWith('admin_cr_rate_set_')));
    assert.match(uiText('multiplier_split_setup'), /✅ v7/); // cancellation/invalid inputs/stale buttons made no writes
    assert.match(uiText('multiplier_split_detail'), /Input ×0,25/);
    assert.match(uiText('multiplier_split_detail'), /pengaturan terpisah sebelumnya akan diganti/);
    assert.match(uiText('multiplier_split_saved'), /Multiplier tersimpan: ×1,5/);
    assert.match(uiText('multiplier_long_saved'), /Multiplier tersimpan: ×1,25/);
    assert.match(uiText('multiplier_long_saved'), /v9/);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'credit-config.json'), 'utf8'));
    assert.equal(config.rates['glm-5v-turbo'].multiplier, '1.5');
    assert.equal(config.rates['glm-5v-turbo'].input, undefined);
    assert.equal(config.rates['deepseek-v4.1-flash'].multiplier, '2.5');
    assert.equal(config.routing.cbcn['deepseek-v4-flash'], 'deepseek-v4.1-flash');
    assert.ok(config.audit.filter(entry => entry.version >= 4).every(entry => entry.by === ADMIN));
    assert.ok(buttons(26).some(button => button.callback_data === 'cr_ul'));
    assert.equal(uiButtons('china_shop').filter(button => button.callback_data?.startsWith('ulbuy_')).length, 7);
    assert.ok(uiButtons('china_shop').some(button => button.text.includes('3 hari') && button.text.includes('Rp29.000')));
    assert.ok(uiButtons('china_shop').some(button => button.text.includes('7 hari') && button.text.includes('Rp59.000')));
    assert.doesNotMatch(uiText('china_shop'), /gpt-|claude|gemini/);
    assert.match(uiText('china_shop'), /<b>1<\/b> request bersamaan, <b>10<\/b> request\/menit/);
    assert.equal(result.cashiOrders[1].amount, 29000);
    assert.equal(result.cashiOrders[2].amount, 59000);
    assert.match(uiText('china_buy_day'), /Unlimited Model China 3 hari/);
    assert.match(uiText('china_paid_day'), /Paket unlimited aktif/);
    assert.match(uiText('china_paid_week'), /Paket unlimited terjadwal/);
    assert.match(uiText('china_active'), /menunggu mulai/);
    assert.match(uiText('china_history'), /unlimited 3 hari/);
    assert.match(uiText('china_history'), /unlimited 7 hari/);
    assert.match(result.cashiOrders[3].order_id, /^TG-700001-/);
    assert.equal(result.cashiOrders[3].amount, 10000);
    assert.match(uiText('rupiah_buy'), /Payment QR ready/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}

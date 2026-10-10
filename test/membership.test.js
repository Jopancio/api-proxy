'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('both groups gate every bot entry; admin can send verification to all users exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-membership-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'membership-harness.js')], {
      cwd: dir, encoding: 'utf8', timeout: 20000,
      env: {
        ...process.env,
        USAGE_DB_PATH: path.join(dir, 'users.json'),
        ADMIN_SETTINGS_PATH: path.join(dir, 'settings.json'),
        MODEL_CACHE_PATH: path.join(dir, 'models.json'),
        CREDIT_CONFIG_PATH: path.join(dir, 'credit-config.json'),
        CREDIT_STATE_PATH: path.join(dir, 'credits.json'),
        ADMIN_TELEGRAM_ID: '6957236291', TELEGRAM_BOT_TOKEN: '123456:test-token',
        CASHI_API_KEY: 'test-key', DATA_API_URL: '', INTERNAL_API_SECRET: '',
        UPSTREAM_API_KEY: '', ADMIN_MINI_APP_URL: '',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Telegram bot @membership_test_bot is running/);
    assert.match(result.stdout, /\[data\] Connection OK/);
    assert.match(result.stderr, /Jadikan bot admin di @galaxy_hub_api/);
    assert.match(result.stderr, /Jadikan bot admin di @galaxy_testi/);
    const { transcript, snapshots, referralCode, broadcastAttempts, broadcastDone, recipients, error } = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(error, null);
    const steps = new Map();
    let current;
    for (const item of transcript) {
      if (item.label) { current = []; steps.set(item.label, current); }
      else if (current) current.push(item);
    }
    const buttons = label => steps.get(label).flatMap(item => item.payload?.reply_markup?.inline_keyboard?.flat() || []);
    const texts = label => steps.get(label).map(item => item.payload?.text || '').join('\n');
    const blocked = [...steps.keys()].filter(label => label.startsWith('blocked_') || label === 'start_blocked'
      || ['verify_left', 'verify_kicked', 'verify_restricted_no', 'verify_unknown', 'verify_error', 'verify_timeout', 'left_again', 'left_testi_again', 'verify_only_hub', 'verify_only_testi', 'verify_testi_error'].includes(label));
    for (const label of blocked) {
      assert.match(texts(label), /Sebelum melanjutkan, join ke kedua grup/, label);
      const controls = buttons(label);
      assert.equal(controls.length, 3, label);
      assert.equal(controls[0].url, 'https://t.me/galaxy_hub_api');
      assert.equal(controls[1].url, 'https://t.me/galaxy_testi');
      assert.match(controls[2].callback_data, /^group_verify/);
      assert.ok(Buffer.byteLength(controls[2].callback_data) <= 64);
      if (!['left_again', 'left_testi_again'].includes(label)) {
        assert.equal(snapshots[label].users['710001'], null, `${label}: no account/key before membership`);
        assert.equal(snapshots[label].bonus, 0, `${label}: no referral reward before membership`);
      }
    }
    assert.equal(snapshots.blocked_admin.users['6957236291'], null);
    assert.equal(buttons('start_blocked')[2].callback_data, `group_verify:${referralCode}`);
    assert.match(texts('verify_error'), /belum bisa diperiksa/);
    assert.match(texts('verify_timeout'), /belum bisa diperiksa/);
    assert.match(texts('verify_ok'), /Keanggotaan terverifikasi/);
    assert.match(texts('verify_ok'), /Silakan pilih bahasa/);
    assert.equal(snapshots.verify_ok.users['710001'].keys, 1);
    assert.equal(snapshots.verify_ok.users['710001'].referredBy, referralCode);
    assert.equal(snapshots.verify_ok.bonus, 1000000);
    assert.ok(buttons('language').some(b => b.callback_data === 'dashboard'));
    assert.equal(snapshots.verify_repeat.users['710001'].keys, 1);
    assert.equal(snapshots.verify_repeat.bonus, 1000000);
    assert.equal(snapshots.left_again.users['710001'].keys, 1);
    assert.equal(snapshots.left_testi_again.users['710001'].keys, 1);
    assert.match(texts('verify_only_hub'), /Galaxy Hub API<\/b>: sudah bergabung/);
    assert.match(texts('verify_only_hub'), /Galaxy Testi<\/b>: belum bergabung/);
    assert.match(texts('verify_testi_error'), /Galaxy Testi<\/b>: belum bisa diperiksa/);
    assert.equal(snapshots.create_key_allowed.users['710001'].keys, 2);
    assert.match(texts('rejoined'), /Keanggotaan terverifikasi/);
    for (const [index, status] of ['member', 'administrator', 'creator', 'restricted'].entries()) {
      assert.equal(snapshots[`allowed_${status}`].users[String(710010 + index)].keys, 1);
      assert.match(texts(`allowed_${status}`), /Silakan pilih bahasa/);
    }
    assert.equal(snapshots.group_ignored.users['710020'], null);
    assert.equal(steps.get('group_ignored').length, 0);
    assert.equal(steps.get('inline_ignored').length, 0);
    for (const [label, entries] of steps) {
      const checks = entries.filter(item => item.method === 'getChatMember');
      if (['group_ignored', 'inline_ignored'].includes(label)) continue;
      assert.equal(checks.length, 2, `${label}: fresh check of both groups, without duplicate command checks`);
      assert.deepEqual(checks.map(check => check.payload.chat_id).sort(), ['@galaxy_hub_api', '@galaxy_testi']);
      for (const check of checks) assert.notEqual(check.payload.user_id, 1, 'check the person clicking, not the message author bot');
      assert.ok(entries.filter(item => item.method === 'answerCallbackQuery').length <= 1);
    }
    assert.ok(buttons('admin_start').some(button => button.callback_data === 'admin_groups'));
    assert.match(texts('admin_groups_denied'), /Access denied/);
    assert.match(texts('admin_send_denied'), /Access denied/);
    assert.match(texts('admin_groups_open'), /semua pengguna lama dan baru/);
    assert.deepEqual(buttons('admin_groups_open').filter(button => button.url).map(button => button.url), ['https://t.me/galaxy_hub_api', 'https://t.me/galaxy_testi']);
    assert.match(texts('admin_prepare_send'), /Pesan yang diterima pengguna/);
    assert.match(texts('admin_cancelled_send'), /Tombol kirim sudah tidak berlaku/);
    assert.equal(snapshots.admin_send_denied.broadcastAttempts, 0, 'no broadcast before authorized admin sends');
    assert.equal(broadcastDone, true);
    assert.deepEqual(broadcastAttempts.map(payload => String(payload.chat_id)).sort(), recipients.sort(), 'all existing users receive one attempt, without duplicates');
    for (const payload of broadcastAttempts) {
      const controls = payload.reply_markup.inline_keyboard.flat();
      assert.deepEqual(controls.map(button => button.url || button.callback_data), ['https://t.me/galaxy_hub_api', 'https://t.me/galaxy_testi', 'group_verify']);
    }
    const finalReport = transcript.find(item => item.method === 'editMessageText' && item.payload.text.includes('Pengiriman verifikasi grup') && item.payload.text.includes('done'));
    assert.match(finalReport.payload.text, /Unreachable.*<b>1<\/b>/);
    assert.match(finalReport.payload.text, new RegExp(`Delivered: <b>${recipients.length - 1}<\\/b>`));
    assert.ok(!fs.existsSync(path.join(dir, 'credits.json')), 'blocked purchases never create credit orders');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

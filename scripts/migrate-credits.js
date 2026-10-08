#!/usr/bin/env node
// Token credit migration.
//
//   node scripts/migrate-credits.js            dry run: shows what would happen, writes nothing
//   node scripts/migrate-credits.js --apply    backs up the data files, then creates data/credits.json
//
// What it does (and does NOT do):
//  - creates the credit state (data/credits.json) with an empty credit account (0 credits) for every
//    existing user and records a snapshot of the old Rupiah balances and bonus tokens;
//  - does NOT change users.json: Rupiah balances, bonus tokens, keys, orders and logs stay as they are
//    and keep working with the old per-1M prices (billing legacy_rupiah on);
//  - does NOT convert Rupiah to credits. When a conversion rule is decided, the admin credits users
//    with "kredit <id> +<jumlah> <alasan>" (written to the credit ledger).
// Running it again changes nothing. Uses USAGE_DB_PATH / CREDIT_STATE_PATH like the services do.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const usageDb = require('../usage-db');
const creditStore = require('../credit-store');
const creditConfig = require('../credit-config');
const adminSettings = require('../admin-settings');

const apply = process.argv.includes('--apply');
const dataDir = path.dirname(usageDb.databasePath);

function backupFiles() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dataDir, 'backups', `pre-credits-${stamp}`);
  fs.mkdirSync(target, { recursive: true });
  const files = [usageDb.databasePath, adminSettings.settingsPath, creditStore.statePath, creditConfig.configPath, path.join(dataDir, 'usage-daily.json')];
  const copied = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    fs.copyFileSync(file, path.join(target, path.basename(file)));
    copied.push(path.basename(file));
  }
  return { target, copied };
}

function main() {
  const users = usageDb.getAllUsers();
  const withRupiah = users.filter((user) => Number(user.balance || 0) > 0);
  const withBonus = users.filter((user) => Number(user.bonusTokens || 0) > 0);
  const pendingOrders = users.flatMap((user) => (user.orders || []).filter((order) => order.status === 'PENDING'));
  const state = creditStore.readState();
  console.log(`Database: ${usageDb.databasePath}`);
  console.log(`Credit state: ${creditStore.statePath} (${fs.existsSync(creditStore.statePath) ? 'exists' : 'not created yet'})`);
  console.log(`Users: ${users.length}`);
  console.log(`Users with a Rupiah balance: ${withRupiah.length} (total Rp${withRupiah.reduce((sum, user) => sum + Number(user.balance), 0).toLocaleString('id-ID')})`);
  console.log(`Users with bonus tokens: ${withBonus.length}`);
  console.log(`Pending Rupiah top-up orders: ${pendingOrders.length} (still credited to the Rupiah balance when paid)`);
  if (state.migration) {
    console.log(`Already migrated at ${state.migration.at}. Nothing to do.`);
    return;
  }
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to back up the data files and create the credit state.');
    console.log('users.json will NOT be changed; no Rupiah balance is converted.');
    return;
  }
  const backup = backupFiles();
  console.log(`Backup: ${backup.target} (${backup.copied.join(', ') || 'no files'})`);
  const result = creditStore.initializeCreditState(users);
  if (result.alreadyMigrated) {
    console.log(`Already migrated at ${result.migration.at}. Nothing changed.`);
    return;
  }
  console.log(`Created ${result.migration.accountsCreated} credit account(s). Legacy snapshot: ${Object.keys(result.migration.legacySnapshot).length} user(s).`);
  console.log('Done. Rupiah balances in users.json are unchanged.');
}

try {
  main();
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exit(1);
}

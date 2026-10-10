#!/usr/bin/env node
'use strict';

// Run from the project directory. Preview by default; --apply saves audited
// configuration changes, with sales enabled only after the complete plan is ready.
if (require.main === module) require('dotenv').config();
const { getModelFamily } = require('../pricing');
const rules = require('../credit-rules');

const CHINA_FAMILIES = ['DeepSeek', 'Kimi', 'GLM', 'Qwen', 'MiniMax', 'Hy'];
const CHINA_PRICES = [[1, 2000], [3, 4000], [6, 6000], [12, 8000], [24, 12000], [72, 29000], [168, 59000]];
const CHINA_LIMITS = { maxConcurrent: 1, rpm: 10, maxOutputTokens: 8192 };

function buildChinaUnlimitedPlan(catalog) {
  const models = [...new Set(catalog.models.filter(entry => entry.listed && entry.status === 'active'
    && [entry.model, entry.routedTo, entry.rateModel].filter(Boolean).every(model => CHINA_FAMILIES.includes(getModelFamily(model))))
    .map(entry => entry.model))].sort();
  if (!models.length) throw new Error('Tidak ada model China aktif di daftar upstream.');
  const desired = {
    name: 'Unlimited Model China', saleEnabled: true,
    durations: CHINA_PRICES.map(([hours, priceIdr]) => ({ hours, priceIdr, active: true })),
    models, limits: { ...CHINA_LIMITS },
  };
  const current = catalog.unlimited;
  const changes = [];
  if (current.name !== desired.name) changes.push({ op: 'setUnlimitedName', name: desired.name });
  const removed = current.models.filter(model => !models.includes(model));
  const added = models.filter(model => !current.models.includes(model));
  if (removed.length) changes.push({ op: 'setUnlimitedModels', action: 'remove', models: removed });
  if (added.length) changes.push({ op: 'setUnlimitedModels', action: 'add', models: added });
  for (const { hours, priceIdr } of desired.durations) {
    if (!rules.UNLIMITED_HOURS.includes(hours)) throw new Error('Upload credit-rules.js terbaru untuk durasi harian.');
    const duration = current.durations.find(item => item.hours === hours);
    if (duration?.priceIdr !== priceIdr) changes.push({ op: 'setUnlimitedPrice', hours, priceIdr });
    if (!duration?.active) changes.push({ op: 'setUnlimitedDuration', hours, active: true });
  }
  for (const [key, value] of Object.entries(desired.limits)) {
    if (current.limits[key] !== value) changes.push({ op: 'setUnlimitedLimit', key, value });
  }
  if (changes.length && current.saleEnabled) changes.unshift({ op: 'setUnlimitedSale', enabled: false });
  if (changes.length || !current.saleEnabled) changes.push({ op: 'setUnlimitedSale', enabled: true });
  return { desired, changes };
}

function main() {
  const fs = require('fs');
  const path = require('path');
  const config = require('../credit-config');
  const plan = buildChinaUnlimitedPlan(config.getCreditCatalog());
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', ...plan }, null, 2));
  if (!process.argv.includes('--apply') || !plan.changes.length) return;
  if (fs.existsSync(config.configPath)) {
    const backup = path.join(path.dirname(config.configPath), 'backups', `unlimited-china-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backup, { recursive: true });
    fs.copyFileSync(config.configPath, path.join(backup, 'credit-config.json'));
    console.log(`Backup: ${backup}`);
  }
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '6957236291').trim();
  for (const change of plan.changes) config.updateCreditConfig(change, adminId);
  console.log(JSON.stringify({ applied: true, unlimited: config.getCreditCatalog().unlimited }));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildChinaUnlimitedPlan, CHINA_FAMILIES, CHINA_PRICES, CHINA_LIMITS };

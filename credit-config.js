// Token credit configuration: packages, model multipliers, aliases, provider routing, limits and
// the unlimited packages. Defaults live in credit-rules.js; the admin's changes are stored as
// overrides in data/credit-config.json (next to users.json), every change authenticated,
// versioned and written to an audit trail. Requests take a snapshot of the rate they were
// started with (credit-store.js), so a change here never alters a request already running.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rules = require('./credit-rules');
const { databasePath, withFileLock, modelCachePath } = require('./usage-db');
const { getModelFamily } = require('./pricing');

const configPath = process.env.CREDIT_CONFIG_PATH
  ? path.resolve(__dirname, process.env.CREDIT_CONFIG_PATH)
  : path.join(path.dirname(databasePath), 'credit-config.json');
const lockPath = `${configPath}.lock`;
// Same variable and default as server.js / telegram-bot.js / usage-db.js.
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '6957236291').trim();
const MAX_AUDIT = 200;

let cached = { key: null, overrides: null, config: null };

function isCreditAdmin(actorId) {
  return Boolean(ADMIN_ID) && String(actorId ?? '').trim() === ADMIN_ID;
}

// Stored overrides ({} when the admin never changed anything). An unreadable file is an error,
// never a silent fallback to the defaults (that could sell at prices the admin already changed).
function readOverrides() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`credit-config.json could not be read; refusing to fall back to defaults: ${error.message}`);
  }
}

function fileKey() {
  try {
    const stat = fs.statSync(configPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

// Effective configuration (defaults + overrides). Re-read only when the file changed.
function getCreditConfig() {
  const key = fileKey();
  if (cached.key !== key || !cached.config) {
    const overrides = readOverrides();
    cached = { key, overrides, config: rules.buildConfig(overrides) };
  }
  return cached.config;
}

function writeOverrides(overrides) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(overrides, null, 2), 'utf8');
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);
  fs.renameSync(temporaryPath, configPath);
  cached = { key: null, overrides: null, config: null };
}

// Applies one admin change (see credit-rules.parseAdminCommand / applyConfigChange). Refused for
// anyone but ADMIN_TELEGRAM_ID. Returns { version, summary, config }.
function updateCreditConfig(change, actorId) {
  if (!isCreditAdmin(actorId)) throw new Error('Hanya admin yang bisa mengubah konfigurasi kredit');
  return withFileLock(lockPath, 'credit-config.json is busy; try again', () => {
    const overrides = readOverrides();
    const current = rules.buildConfig(overrides);
    const next = rules.applyConfigChange(overrides, change, current);
    const at = new Date().toISOString();
    const summary = rules.describeChange(change);
    next.version = (current.version || 0) + 1;
    next.updatedAt = at;
    next.updatedBy = String(actorId).trim();
    next.audit = [...(Array.isArray(overrides.audit) ? overrides.audit : []), { at, by: next.updatedBy, version: next.version, change: summary }].slice(-MAX_AUDIT);
    writeOverrides(next);
    console.log(`[credits] config v${next.version} by ${next.updatedBy}: ${summary}`);
    return { version: next.version, summary, config: rules.buildConfig(next) };
  });
}

// Newest first.
function getCreditConfigAudit(limit = 20) {
  const audit = readOverrides().audit;
  return (Array.isArray(audit) ? audit : []).slice(-Math.max(1, Number(limit) || 20)).reverse();
}

// Models the bot last synced from upstream (display name -> upstream route).
function readModelCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(modelCachePath, 'utf8'));
    return {
      models: Array.isArray(cache.models) ? cache.models.map(rules.modelKey) : [],
      aliases: cache.aliases && typeof cache.aliases === 'object' ? cache.aliases : {},
    };
  } catch (_) {
    return { models: [], aliases: {} };
  }
}

// Upstream route server.js uses for a display name (same rule as resolveUpstreamModel there).
function routeFor(model, aliases) {
  const route = aliases[model];
  if (route) return String(route);
  return model.includes('/') ? model : `1/${model}`;
}

// Everything the bot shows about credits: packages, every model with its multiplier and status
// (after alias and provider routing, for the provider the model is currently served by), the
// unlimited packages and the limits that matter to users.
function getCreditCatalog() {
  const config = getCreditConfig();
  const cache = readModelCache();
  const names = [...new Set([...cache.models, ...Object.keys(config.rates)])].filter((model) => getModelFamily(model)).sort();
  const models = names.map((model) => {
    const route = routeFor(model, cache.aliases);
    const provider = rules.providerOf(route);
    const resolved = rules.resolveRate(config, { model, provider });
    const entry = config.rates[model] || null;
    const base = {
      model,
      family: getModelFamily(model),
      provider,
      listed: cache.models.includes(model),
      type: entry?.type || null,
      note: entry?.note || '',
      target: entry?.status === 'alias' ? entry.target : null,
    };
    if (resolved.ok) {
      const snapshot = resolved.snapshot;
      return {
        ...base,
        status: 'active',
        alias: entry?.status === 'alias',
        multiplier: snapshot.multiplier,
        multiplierUnits: snapshot.units.output,
        rateModel: snapshot.rateModel,
        routedTo: snapshot.routedTo,
        toolCallCredits: snapshot.toolCallCredits || 0,
        split: snapshot.units.input !== snapshot.units.output || snapshot.units.cachedInput !== snapshot.units.input,
        units: snapshot.units,
      };
    }
    return { ...base, status: entry?.status === 'alias' ? 'alias' : 'pending', alias: entry?.status === 'alias', multiplier: null, reason: resolved.reason };
  });
  return {
    version: config.version,
    packages: config.packages,
    billing: config.billing,
    limits: { defaultReserveOutputTokens: config.limits.defaultReserveOutputTokens, minOutputTokens: config.limits.minOutputTokens },
    unlimited: config.unlimited,
    models,
  };
}

// Admin view: the full effective configuration, the providers in use and the latest audit entries.
function getCreditAdmin() {
  const config = getCreditConfig();
  const cache = readModelCache();
  const providers = {};
  for (const model of cache.models) {
    const provider = rules.providerOf(routeFor(model, cache.aliases));
    (providers[provider] = providers[provider] || []).push(model);
  }
  return { config, providers, audit: getCreditConfigAudit(15), configPath: path.basename(configPath) };
}

module.exports = {
  configPath, isCreditAdmin, getCreditConfig, updateCreditConfig, getCreditConfigAudit, getCreditCatalog, getCreditAdmin, readModelCache, routeFor,
};

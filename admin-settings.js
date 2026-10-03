const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const configuredSettingsPath = process.env.ADMIN_SETTINGS_PATH;
const settingsPath = configuredSettingsPath
  ? (path.isAbsolute(configuredSettingsPath) ? configuredSettingsPath : path.resolve(__dirname, configuredSettingsPath))
  : path.join(__dirname, 'data', 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return { allModelsFree: false, announcement: '' };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function isAllModelsFree() {
  return readSettings().allModelsFree === true;
}

function setAllModelsFree(enabled) {
  const settings = readSettings();
  settings.allModelsFree = Boolean(enabled);
  writeSettings(settings);
  return settings;
}

// Payments are ON unless an admin explicitly turned them off.
function isPaymentsEnabled() {
  return readSettings().paymentsEnabled !== false;
}

function setPaymentsEnabled(enabled) {
  const settings = readSettings();
  settings.paymentsEnabled = Boolean(enabled);
  writeSettings(settings);
  return settings;
}

function setAnnouncement(message) {
  const settings = readSettings();
  settings.announcement = String(message || '');
  settings.announcementAt = new Date().toISOString();
  writeSettings(settings);
  return settings;
}

// Recent prompts (bot: Admin Panel -> Recent Prompts). OFF unless the admin switched it on,
// so no prompt text is recorded by default.
function isPromptLogEnabled() {
  return readSettings().promptLogEnabled === true;
}

function setPromptLogEnabled(enabled) {
  const settings = readSettings();
  settings.promptLogEnabled = Boolean(enabled);
  writeSettings(settings);
  return settings.promptLogEnabled;
}

// ---------- Disabled models ----------
// Models are stored by display name (without any route prefix such as "1/", "cx/" or "cbcn/"),
// families by name ("Qwen", "ChatGPT", ...).

function modelKey(model) {
  return String(model || '').trim().replace(/^.*\//, '').toLowerCase();
}

function getDisabledModels() {
  const settings = readSettings();
  return {
    models: Array.isArray(settings.disabledModels) ? settings.disabledModels : [],
    families: Array.isArray(settings.disabledFamilies) ? settings.disabledFamilies : [],
  };
}

function toggleListEntry(list, value, disabled) {
  const rest = list.filter((entry) => entry !== value);
  return disabled ? [...rest, value] : rest;
}

function setModelDisabled(model, disabled) {
  const key = modelKey(model);
  if (!key) return getDisabledModels();
  const settings = readSettings();
  settings.disabledModels = toggleListEntry(Array.isArray(settings.disabledModels) ? settings.disabledModels : [], key, Boolean(disabled));
  writeSettings(settings);
  return getDisabledModels();
}

function setFamilyDisabled(family, disabled) {
  const name = String(family || '').trim();
  if (!name) return getDisabledModels();
  const settings = readSettings();
  settings.disabledFamilies = toggleListEntry(Array.isArray(settings.disabledFamilies) ? settings.disabledFamilies : [], name, Boolean(disabled));
  writeSettings(settings);
  return getDisabledModels();
}

// `family` is passed in by the caller (pricing.getModelFamily) to avoid a
// circular require between this file and pricing.js.
function isModelDisabled(model, family) {
  const { models, families } = getDisabledModels();
  return models.includes(modelKey(model)) || Boolean(family && families.includes(family));
}

// ---------- Rate limits ----------
// Requests per minute, counted per user. Models are keyed like disabled models
// (display name, lowercase); families by name. A model rule beats its family rule.
const MAX_RPM = 10_000;

function normalizeRpm(rpm) {
  const value = Number(rpm);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_RPM) : 0;
}

function getRateLimits() {
  const limits = readSettings().rateLimits || {};
  return {
    models: { ...(limits.models && typeof limits.models === 'object' ? limits.models : {}) },
    families: { ...(limits.families && typeof limits.families === 'object' ? limits.families : {}) },
  };
}

// rpm <= 0 (or invalid) removes the rule.
function setRateLimitEntry(group, key, rpm) {
  if (!key) return getRateLimits();
  const settings = readSettings();
  const limits = getRateLimits();
  const value = normalizeRpm(rpm);
  if (value) limits[group][key] = value;
  else delete limits[group][key];
  settings.rateLimits = limits;
  writeSettings(settings);
  return getRateLimits();
}

function setModelRateLimit(model, rpm) {
  return setRateLimitEntry('models', modelKey(model), rpm);
}

function setFamilyRateLimit(family, rpm) {
  return setRateLimitEntry('families', String(family || '').trim(), rpm);
}

// `family` comes from pricing.getModelFamily, as with isModelDisabled.
function getRateLimitFor(model, family) {
  const { models, families } = getRateLimits();
  const key = modelKey(model);
  if (models[key]) return { rpm: models[key], scope: 'model', name: key, key: `model:${key}` };
  if (family && families[family]) return { rpm: families[family], scope: 'family', name: family, key: `family:${family}` };
  return null;
}

// ---------- BANSOS (temporary free models) ----------
// Admin-scheduled windows in which chosen models and/or whole families cost Rp0.
// settings.bansos = [{ id, models: [model keys], families: [names], startsAt, endsAt,
//   createdAt, createdBy, stoppedAt?, stoppedBy? }]
// Whether a window is on is worked out from the clock on every check, so pricing and
// access go back to normal by themselves once `endsAt` passes. No timer is involved.
const MIN_BANSOS_DURATION_MS = 60 * 1000;
const MAX_BANSOS_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BANSOS_START_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BANSOS_TARGETS = 200;
const MAX_BANSOS_OPEN = 15; // active + scheduled at the same time (all fit on the admin screen)
const MAX_BANSOS_HISTORY = 20; // finished (ended or stopped) windows kept for the admin view
const BANSOS_STATUS_ORDER = { active: 0, scheduled: 1, ended: 2, stopped: 2 };

function bansosStatus(entry, now = Date.now()) {
  if (entry.stoppedAt) return 'stopped';
  if (now >= Date.parse(entry.endsAt)) return 'ended';
  if (now < Date.parse(entry.startsAt)) return 'scheduled';
  return 'active';
}

function isBansosOpen(entry, now) {
  const status = bansosStatus(entry, now);
  return status === 'active' || status === 'scheduled';
}

function readBansos(settings = readSettings()) {
  const list = Array.isArray(settings.bansos) ? settings.bansos : [];
  return list
    .filter((entry) => entry && typeof entry.id === 'string'
      && Number.isFinite(Date.parse(entry.startsAt)) && Number.isFinite(Date.parse(entry.endsAt)))
    .map((entry) => ({
      ...entry,
      models: Array.isArray(entry.models) ? entry.models : [],
      families: Array.isArray(entry.families) ? entry.families : [],
    }));
}

function bansosFinishedAt(entry) {
  return Date.parse(entry.stoppedAt || entry.endsAt);
}

// Keeps every open window and only the latest finished ones.
function pruneBansos(entries, now) {
  const history = entries.filter((entry) => !isBansosOpen(entry, now))
    .sort((a, b) => bansosFinishedAt(b) - bansosFinishedAt(a))
    .slice(0, MAX_BANSOS_HISTORY);
  return entries.filter((entry) => isBansosOpen(entry, now) || history.includes(entry));
}

// Every stored window with its current `status`: active ones first (ending soonest
// first), then scheduled (starting soonest first), then finished (most recent first).
function listBansos() {
  const now = Date.now();
  return readBansos()
    .map((entry) => ({ ...entry, status: bansosStatus(entry, now) }))
    .sort((a, b) => {
      const order = BANSOS_STATUS_ORDER[a.status] - BANSOS_STATUS_ORDER[b.status];
      if (order) return order;
      if (a.status === 'active') return Date.parse(a.endsAt) - Date.parse(b.endsAt);
      if (a.status === 'scheduled') return Date.parse(a.startsAt) - Date.parse(b.startsAt);
      return bansosFinishedAt(b) - bansosFinishedAt(a);
    });
}

function parseBansosTime(value, label) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid ${label} time`);
  return time;
}

// Creates one window. `startsAt` missing or already past = start now. The end is
// either `endsAt` or `startsAt + durationMs`. Throws with a readable reason when invalid.
function createBansos({ models = [], families = [], startsAt, endsAt, durationMs, createdBy = '' } = {}) {
  const modelKeys = [...new Set((Array.isArray(models) ? models : [models]).map(modelKey).filter(Boolean))];
  const familyNames = [...new Set((Array.isArray(families) ? families : [families])
    .map((family) => String(family || '').trim().slice(0, 50)).filter(Boolean))];
  if (!modelKeys.length && !familyNames.length) throw new Error('Choose at least one model or family');
  if (modelKeys.length + familyNames.length > MAX_BANSOS_TARGETS) throw new Error(`At most ${MAX_BANSOS_TARGETS} models/families per BANSOS`);

  const now = Date.now();
  const start = startsAt ? Math.max(now, parseBansosTime(startsAt, 'start')) : now;
  if (start - now > MAX_BANSOS_START_AHEAD_MS) throw new Error('The start time can be at most 365 days ahead');
  let end;
  if (endsAt) {
    end = parseBansosTime(endsAt, 'end');
  } else {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Set an end time or a duration');
    end = start + duration;
  }
  if (end - start < MIN_BANSOS_DURATION_MS) throw new Error('The end time must be at least 1 minute after the start');
  if (end - start > MAX_BANSOS_DURATION_MS) throw new Error('A BANSOS can last at most 90 days');

  const settings = readSettings();
  const entries = readBansos(settings);
  if (entries.filter((entry) => isBansosOpen(entry, now)).length >= MAX_BANSOS_OPEN) {
    throw new Error(`Too many active/scheduled BANSOS (max ${MAX_BANSOS_OPEN}). Stop one first.`);
  }
  const taken = new Set(entries.map((entry) => entry.id));
  let id;
  do {
    id = crypto.randomBytes(3).toString('hex');
  } while (taken.has(id));
  const entry = {
    id,
    models: modelKeys,
    families: familyNames,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    createdAt: new Date(now).toISOString(),
    createdBy: String(createdBy),
  };
  settings.bansos = pruneBansos([...entries, entry], now);
  writeSettings(settings);
  return { ...entry, status: bansosStatus(entry, now) };
}

// Ends an active window now, or cancels a scheduled one. Null when it is not open.
function stopBansos(id, stoppedBy = '') {
  const settings = readSettings();
  const entries = readBansos(settings);
  const now = Date.now();
  const entry = entries.find((item) => item.id === String(id || '').trim().toLowerCase());
  if (!entry || !isBansosOpen(entry, now)) return null;
  entry.stoppedAt = new Date(now).toISOString();
  entry.stoppedBy = String(stoppedBy);
  settings.bansos = pruneBansos(entries, now);
  writeSettings(settings);
  return { ...entry, status: 'stopped' };
}

// The active window that makes `model` free right now, or null. `family` comes
// from pricing.getModelFamily, as with isModelDisabled.
function getBansosFor(model, family) {
  const key = modelKey(model);
  if (!key) return null;
  const now = Date.now();
  return readBansos().find((entry) => bansosStatus(entry, now) === 'active'
    && (entry.models.includes(key) || Boolean(family && entry.families.includes(family)))) || null;
}

// ---------- Referrals ----------
// The inviter earns `rewardTokens` bonus tokens per new user who joins via their
// link. `maxRewardsPerUser` caps how many invites one user is paid for (0 = no cap).
const DEFAULT_REFERRAL_REWARD = 10_000_000;
const MAX_REFERRAL_REWARD = 1_000_000_000;
const MAX_REFERRAL_CAP = 100_000;

function getReferralSettings() {
  const referral = readSettings().referral || {};
  const reward = Number(referral.rewardTokens);
  const cap = Number(referral.maxRewardsPerUser);
  return {
    enabled: referral.enabled !== false,
    rewardTokens: Number.isSafeInteger(reward) && reward > 0 ? reward : DEFAULT_REFERRAL_REWARD,
    maxRewardsPerUser: Number.isSafeInteger(cap) && cap > 0 ? cap : 0,
  };
}

// Partial update: only the fields given are changed. Invalid values are ignored.
function setReferralSettings(changes = {}) {
  const settings = readSettings();
  const referral = getReferralSettings();
  if (changes.enabled !== undefined) referral.enabled = Boolean(changes.enabled);
  const reward = Number(changes.rewardTokens);
  if (Number.isSafeInteger(reward) && reward > 0 && reward <= MAX_REFERRAL_REWARD) referral.rewardTokens = reward;
  const cap = Number(changes.maxRewardsPerUser);
  if (Number.isSafeInteger(cap) && cap >= 0 && cap <= MAX_REFERRAL_CAP) referral.maxRewardsPerUser = cap;
  settings.referral = referral;
  writeSettings(settings);
  return getReferralSettings();
}

module.exports = {
  readSettings, isAllModelsFree, setAllModelsFree, isPaymentsEnabled, setPaymentsEnabled, setAnnouncement, settingsPath,
  isPromptLogEnabled, setPromptLogEnabled,
  getDisabledModels, setModelDisabled, setFamilyDisabled, isModelDisabled,
  MAX_RPM, getRateLimits, setModelRateLimit, setFamilyRateLimit, getRateLimitFor,
  MAX_BANSOS_DURATION_MS, MAX_BANSOS_START_AHEAD_MS, listBansos, createBansos, stopBansos, getBansosFor,
  DEFAULT_REFERRAL_REWARD, MAX_REFERRAL_REWARD, MAX_REFERRAL_CAP, getReferralSettings, setReferralSettings,
};

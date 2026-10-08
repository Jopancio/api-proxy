// Token credit rules: default packages and model multipliers, fixed-point credit math, usage
// normalisation across provider formats, rate resolution (aliases, effort variants, provider
// routing) and the admin command parser.
//
// Pure module: no file access, no clock-dependent state. credit-config.js stores the admin's
// overrides, credit-store.js keeps balances, reservations and the ledger; both build on this.
//
// Credits used = (billed input tokens + billed output tokens) x multiplier, rounded UP to a whole
// credit once, after every component was added. Multipliers are fixed-point integers with 4
// decimals (MULTIPLIER_SCALE), and the math runs on BigInt, so 1.75 is exact and nothing drifts.
'use strict';

const MULTIPLIER_SCALE = 10_000;
const SCALE = BigInt(MULTIPLIER_SCALE);
const MAX_MULTIPLIER_UNITS = 1_000 * MULTIPLIER_SCALE; // x1000
const MAX_CREDITS = 1_000_000_000_000_000; // 1e15, below Number.MAX_SAFE_INTEGER
const MAX_PACKAGE_CREDITS = 1_000_000_000_000;
const MAX_PRICE_IDR = 100_000_000;
const MAX_TOOL_CALL_CREDITS = 100_000_000;
const MAX_TOKENS = 100_000_000;
const MODEL_NAME = /^[a-z0-9][a-z0-9._:+-]{0,99}$/;
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,23}$/;
const UNLIMITED_HOURS = [1, 3, 6, 12, 24];

// ---------- Fixed-point multipliers ----------

// "1.75" / "1,75" / 1.75 -> 17500. Throws a readable reason for anything else, including 0:
// a model is never made free by its multiplier.
function parseMultiplier(value) {
  const text = String(value ?? '').trim().replace(',', '.').replace(/^x/i, '');
  const match = text.match(/^(\d{1,4})(?:\.(\d{1,4}))?$/);
  if (!match) throw new Error(`Multiplier tidak valid: "${String(value ?? '').slice(0, 20)}" (contoh: 1.25, maks 4 desimal)`);
  const units = Number(match[1]) * MULTIPLIER_SCALE + Number((match[2] || '').padEnd(4, '0'));
  if (units <= 0) throw new Error('Multiplier harus lebih dari 0 (model tidak boleh digratiskan lewat multiplier)');
  if (units > MAX_MULTIPLIER_UNITS) throw new Error('Multiplier maksimal 1000');
  return units;
}

// 17500 -> "1.75"
function formatMultiplier(units) {
  const value = Number(units);
  if (!Number.isSafeInteger(value) || value <= 0) return '-';
  const whole = Math.floor(value / MULTIPLIER_SCALE);
  const fraction = String(value % MULTIPLIER_SCALE).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// Credits for one request. `units` = { input, cachedInput, output } multipliers in fixed point;
// `counts` = billed { inputTokens (cached ones included), cachedInputTokens, outputTokens, toolCalls }.
// Rounded up once at the end; tool calls add whole credits.
function computeCredits(units, counts = {}, toolCallCredits = 0) {
  const input = BigInt(toCount(counts.inputTokens));
  const cached = BigInt(Math.min(toCount(counts.cachedInputTokens), toCount(counts.inputTokens)));
  const output = BigInt(toCount(counts.outputTokens));
  const scaled = (input - cached) * BigInt(units.input)
    + cached * BigInt(units.cachedInput ?? units.input)
    + output * BigInt(units.output);
  let credits = (scaled + SCALE - 1n) / SCALE;
  credits += BigInt(toCount(counts.toolCalls)) * BigInt(toCount(toolCallCredits));
  if (credits > BigInt(MAX_CREDITS)) throw new Error('Credit amount out of range');
  return Number(credits);
}

// How many output tokens `credits` pays for at the output multiplier (rounded down).
function affordableOutputTokens(units, credits) {
  const budget = BigInt(Math.max(0, Math.floor(Number(credits) || 0)));
  return Number((budget * SCALE) / BigInt(units.output));
}

// Rough token equivalent of a credit amount at multiplier `units` (display only).
function tokensForCredits(credits, units) {
  const budget = BigInt(Math.max(0, Math.floor(Number(credits) || 0)));
  return Number((budget * SCALE) / BigInt(units));
}

// ---------- Usage normalisation ----------
// Every provider reports usage differently. Normalised result (all integers >= 0):
//   inputTokens        every input token processed, cached ones INCLUDED
//   cachedInputTokens  the cached part of inputTokens (never billed on top of it)
//   outputTokens       every output token, reasoning INCLUDED exactly once
//   reasoningTokens    the reasoning part of outputTokens (informational)
//   toolCalls          provider-side tool calls (web search etc.), billed per call when configured
//
// - OpenAI chat/completions, Responses, DeepSeek, most OpenAI-compatible proxies: cached tokens
//   are part of prompt/input tokens; reasoning tokens are part of completion/output tokens.
// - Anthropic messages: cache_read_input_tokens / cache_creation_input_tokens are reported NEXT
//   TO input_tokens, so they are added to it (they are real input), the read part being cached.
// - A provider that reports reasoning OUTSIDE completion_tokens is recognised by arithmetic only:
//   total_tokens = prompt + completion + reasoning, or reasoning > completion. Then it is added.
// - Gemini native usageMetadata: thoughtsTokenCount is separate from candidatesTokenCount.
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function sumNumbers(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum, item) => sum + (numberOrNull(item) || 0), 0);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  if (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined) {
    const reasoning = numberOrNull(usage.thoughtsTokenCount) || 0;
    const input = (numberOrNull(usage.promptTokenCount) || 0) + (numberOrNull(usage.toolUsePromptTokenCount) || 0);
    return {
      inputTokens: input,
      cachedInputTokens: Math.min(input, numberOrNull(usage.cachedContentTokenCount) || 0),
      outputTokens: (numberOrNull(usage.candidatesTokenCount) || 0) + reasoning,
      reasoningTokens: reasoning,
      toolCalls: 0,
    };
  }
  const promptRaw = numberOrNull(usage.prompt_tokens ?? usage.input_tokens);
  const completionRaw = numberOrNull(usage.completion_tokens ?? usage.output_tokens);
  if (promptRaw === null && completionRaw === null) return null;
  let input = promptRaw || 0;
  let output = completionRaw || 0;
  let cached = 0;
  const cacheRead = numberOrNull(usage.cache_read_input_tokens);
  const cacheWrite = numberOrNull(usage.cache_creation_input_tokens);
  if (cacheRead !== null || cacheWrite !== null) {
    input += (cacheRead || 0) + (cacheWrite || 0);
    cached = cacheRead || 0;
  } else {
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    cached = numberOrNull(details.cached_tokens) ?? numberOrNull(usage.prompt_cache_hit_tokens) ?? numberOrNull(usage.cached_tokens) ?? 0;
  }
  const outputDetails = usage.completion_tokens_details || usage.output_tokens_details || {};
  const reasoning = numberOrNull(outputDetails.reasoning_tokens) ?? numberOrNull(usage.reasoning_tokens) ?? 0;
  const total = numberOrNull(usage.total_tokens);
  const reasoningOutside = reasoning > 0 && (
    reasoning > output
    || (total !== null && promptRaw !== null && total === (promptRaw || 0) + output + reasoning && total !== (promptRaw || 0) + output)
  );
  if (reasoningOutside) output += reasoning;
  return {
    inputTokens: input,
    cachedInputTokens: Math.min(input, cached),
    outputTokens: output,
    reasoningTokens: Math.min(output, reasoning),
    toolCalls: sumNumbers(usage.server_tool_use),
  };
}

// Streams repeat cumulative counts (Anthropic splits input and output over two events), so the
// highest value of each field wins.
function mergeUsage(current, next) {
  if (!next) return current;
  if (!current) return { ...next };
  const merged = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'toolCalls']) {
    merged[key] = Math.max(current[key] || 0, next[key] || 0);
  }
  return merged;
}

// ---------- Default configuration ----------
// The selling rates below are this store's configuration, not benchmarks or official provider
// prices. Every value can be changed by the admin (credit-config.js stores the overrides).
const active = (multiplier, extra = {}) => ({ status: 'active', multiplier, ...extra });
const pending = (note = 'Tarif belum ditetapkan') => ({ status: 'pending', note });
const alias = (note, extra = {}) => ({ status: 'alias', target: null, note, ...extra });

const DEFAULT_RATES = Object.freeze({
  // ChatGPT
  'gpt-6-luna': active('1'),
  'gpt-6-sol': active('2'),
  'gpt-oss-120b-medium': active('0.5'),
  // Hy
  hy3: active('1'),
  'hy4-preview': active('1.75'),
  // DeepSeek. The undated names are rolling aliases: their own rate applies unless the admin
  // records (per provider, see routing) that the provider serves them with another checkpoint.
  'deepseek-v4-flash': active('1.25', { type: 'alias', note: 'Alias bergulir; atur routing per provider jika diarahkan ke checkpoint lain' }),
  'deepseek-v4-flash-0731': active('1.25', { type: 'checkpoint' }),
  'deepseek-v4-pro': active('1.75', { type: 'alias', note: 'Alias bergulir; atur routing per provider jika diarahkan ke checkpoint lain' }),
  'deepseek-v4-pro-0813': active('1.75', { type: 'checkpoint' }),
  'deepseek-v4.1-flash': active('1.5', { type: 'checkpoint' }),
  // GLM
  'glm-5.1': active('1.25'),
  'glm-5.2': active('1.75'),
  'glm-5.3-flash': active('1.5'),
  'glm-5v-turbo': pending(),
  // Kimi
  'kimi-k2.6': active('1.5'),
  'kimi-k2.7': active('1.75'),
  'kimi-k3-1': pending(),
  // Gemini
  'gemini-3-flash': active('0.75'),
  'gemini-3-flash-agent': alias('Mengikuti model tujuan + biaya tool', { requiresToolPrice: true, toolCallCredits: null }),
  'gemini-3.1-pro-low': active('1.5'),
  'gemini-3.5-flash-extra-low': active('0.75'),
  'gemini-3.5-flash-low': active('0.75'),
  'gemini-3.5-flash-high': active('1.25'),
  'gemini-3.6-flash-low': active('0.75'),
  'gemini-3.6-flash-medium': active('1'),
  'gemini-3.6-flash-high': active('1.25'),
  'gemini-3.7-flash-low': active('1'),
  'gemini-3.7-flash-medium': active('1.25'),
  'gemini-3.7-flash-high': active('1.5'),
  'gemini-3.8-flash': alias('Mengikuti effort default provider'),
  'gemini-3.8-flash-low': active('1'),
  'gemini-3.8-flash-medium': active('1.25'),
  'gemini-3.8-flash-high': active('1.5'),
  'gemini-pro-agent': alias('Mengikuti model tujuan + biaya tool', { requiresToolPrice: true, toolCallCredits: null }),
  // MiniMax
  'minimax-m2.7': active('1'),
  'minimax-m3': active('1.5'),
  // Claude
  claude: alias('Mengikuti model tujuan alias'),
  'claude-opus-4-6-thinking': active('3'),
  'claude-sonnet-4-6': active('1.5'),
  'claude-sonnet-5-5-low': active('2'),
  'claude-sonnet-5-5-medium': active('2.25'),
  'claude-sonnet-5-5-high': active('2.5'),
});

const DEFAULT_PACKAGES = Object.freeze([
  { id: 'kredit-10m', credits: 10_000_000, priceIdr: 4_000, active: true },
  { id: 'kredit-25m', credits: 25_000_000, priceIdr: 8_000, active: true },
  { id: 'kredit-50m', credits: 50_000_000, priceIdr: 15_000, active: true },
  { id: 'kredit-100m', credits: 100_000_000, priceIdr: 28_000, active: true },
]);

const DEFAULT_LIMITS = Object.freeze({
  // Output tokens reserved when the client sets no limit (more is still billed if the balance allows).
  defaultReserveOutputTokens: 8192,
  // Smallest output a request must be able to afford; below it the request is refused (402).
  minOutputTokens: 256,
  // Extra margin on the text-based input estimate used for the reservation.
  inputSafetyPercent: 25,
  // Field written on chat/completions when the output limit has to be set or lowered.
  chatMaxTokensField: 'max_tokens',
  // A reservation older than this is treated as abandoned by the sweeper.
  reservationTtlMinutes: 180,
  // Abandoned reservation (server crash / restart): charge the input estimate, or release it.
  orphanPolicy: 'charge_input_estimate',
  // Provider-side tool calls reserved up front for models with a tool price.
  toolCallReserve: 1,
});

const DEFAULT_BILLING = Object.freeze({
  creditSalesEnabled: true,
  // Users with an old Rupiah balance keep using it with the old per-1M prices when they have no
  // credits (or the model has no credit rate yet). Credits and Rupiah are never mixed or converted.
  legacyRupiahEnabled: true,
  legacyTopupEnabled: true,
});

const DEFAULT_UNLIMITED = Object.freeze({
  name: 'Unlimited Model China',
  saleEnabled: false,
  // Prices are not decided yet: empty and not for sale until the admin sets them.
  durations: UNLIMITED_HOURS.map((hours) => ({ hours, priceIdr: null, active: false })),
  models: [],
  limits: { maxConcurrent: 2, rpm: 20, maxOutputTokens: 8192 },
});

const LIMIT_RULES = {
  defaultReserveOutputTokens: { type: 'int', min: 1, max: 1_000_000 },
  minOutputTokens: { type: 'int', min: 1, max: 100_000 },
  inputSafetyPercent: { type: 'int', min: 0, max: 500 },
  chatMaxTokensField: { type: 'enum', values: ['max_tokens', 'max_completion_tokens'] },
  reservationTtlMinutes: { type: 'int', min: 5, max: 7 * 24 * 60 },
  orphanPolicy: { type: 'enum', values: ['charge_input_estimate', 'release'] },
  toolCallReserve: { type: 'int', min: 0, max: 100 },
};
const LIMIT_ALIASES = {
  output_default: 'defaultReserveOutputTokens',
  output_min: 'minOutputTokens',
  input_buffer: 'inputSafetyPercent',
  max_tokens_field: 'chatMaxTokensField',
  ttl: 'reservationTtlMinutes',
  orphan: 'orphanPolicy',
  tool_reserve: 'toolCallReserve',
};
const BILLING_ALIASES = {
  jual_kredit: 'creditSalesEnabled',
  legacy_rupiah: 'legacyRupiahEnabled',
  legacy_topup: 'legacyTopupEnabled',
};
const UNLIMITED_LIMIT_RULES = {
  maxConcurrent: { min: 1, max: 100 },
  rpm: { min: 1, max: 10_000 },
  maxOutputTokens: { min: 1, max: 1_000_000 },
};
const UNLIMITED_LIMIT_ALIASES = { concurrency: 'maxConcurrent', rpm: 'rpm', output: 'maxOutputTokens' };

// ---------- Normalisation of stored configuration ----------

function modelKey(model) {
  return String(model || '').trim().replace(/^.*\//, '').toLowerCase();
}

// Upstream route "cbcn/glm-5.2" -> provider "cbcn"; a bare name -> "default".
function providerOf(route) {
  const text = String(route || '').trim().toLowerCase();
  const index = text.indexOf('/');
  return index > 0 ? text.slice(0, index) : 'default';
}

function safeUnits(value) {
  try {
    return parseMultiplier(value);
  } catch (_) {
    return null;
  }
}

// A stored rate entry made safe to use; anything unreadable becomes "pending" (never free).
function normalizeRate(entry) {
  if (!entry || typeof entry !== 'object') return { status: 'pending', note: 'Konfigurasi tarif tidak valid' };
  const note = typeof entry.note === 'string' ? entry.note.slice(0, 200) : '';
  const type = entry.type === 'checkpoint' || entry.type === 'alias' ? entry.type : undefined;
  if (entry.status === 'active') {
    const units = safeUnits(entry.multiplier);
    if (!units) return { status: 'pending', note: 'Multiplier tidak valid' };
    const rate = { status: 'active', multiplier: formatMultiplier(units) };
    for (const part of ['input', 'cachedInput', 'output']) {
      if (entry[part] !== undefined && entry[part] !== null) {
        const partUnits = safeUnits(entry[part]);
        if (!partUnits) return { status: 'pending', note: `Multiplier ${part} tidak valid` };
        rate[part] = formatMultiplier(partUnits);
      }
    }
    if (type) rate.type = type;
    if (note) rate.note = note;
    return rate;
  }
  if (entry.status === 'alias') {
    const target = entry.target ? modelKey(entry.target) : null;
    const effortTargets = {};
    for (const [effort, value] of Object.entries(entry.effortTargets && typeof entry.effortTargets === 'object' ? entry.effortTargets : {})) {
      if (EFFORT_NAME.test(effort) && MODEL_NAME.test(modelKey(value))) effortTargets[effort] = modelKey(value);
    }
    const tool = entry.toolCallCredits === null || entry.toolCallCredits === undefined ? null : Number(entry.toolCallCredits);
    const rate = {
      status: 'alias',
      target: target && MODEL_NAME.test(target) ? target : null,
      effortTargets,
      requiresToolPrice: entry.requiresToolPrice === true,
      toolCallCredits: Number.isSafeInteger(tool) && tool >= 0 && tool <= MAX_TOOL_CALL_CREDITS ? tool : null,
    };
    if (note) rate.note = note;
    return rate;
  }
  return { status: 'pending', note: note || 'Tarif belum ditetapkan' };
}

function normalizePackages(list) {
  const seen = new Set();
  const packages = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.id || '').trim().toLowerCase();
    const credits = Number(item?.credits);
    const priceIdr = Number(item?.priceIdr);
    if (!PACKAGE_ID.test(id) || seen.has(id)) continue;
    if (!Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_PACKAGE_CREDITS) continue;
    if (!Number.isSafeInteger(priceIdr) || priceIdr <= 0 || priceIdr > MAX_PRICE_IDR) continue;
    seen.add(id);
    packages.push({ id, credits, priceIdr, active: item.active !== false });
  }
  return packages.sort((a, b) => a.credits - b.credits || a.id.localeCompare(b.id));
}

function normalizeRouting(routing) {
  const result = {};
  for (const [provider, rules] of Object.entries(routing && typeof routing === 'object' ? routing : {})) {
    if (!PROVIDER_NAME.test(provider) || !rules || typeof rules !== 'object') continue;
    const clean = {};
    for (const [model, target] of Object.entries(rules)) {
      const from = modelKey(model);
      const to = modelKey(target);
      if (MODEL_NAME.test(from) && MODEL_NAME.test(to) && from !== to) clean[from] = to;
    }
    if (Object.keys(clean).length) result[provider] = clean;
  }
  return result;
}

function normalizeLimitValue(key, value) {
  const rule = LIMIT_RULES[key];
  if (!rule) return undefined;
  if (rule.type === 'enum') return rule.values.includes(value) ? value : undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= rule.min && number <= rule.max ? number : undefined;
}

function normalizeLimits(limits) {
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits && typeof limits === 'object' ? limits : {})) {
    const clean = normalizeLimitValue(key, value);
    if (clean !== undefined) result[key] = clean;
  }
  return result;
}

function normalizeBilling(billing) {
  const result = { ...DEFAULT_BILLING };
  for (const key of Object.keys(DEFAULT_BILLING)) {
    if (typeof billing?.[key] === 'boolean') result[key] = billing[key];
  }
  return result;
}

function normalizeUnlimited(unlimited = {}) {
  const source = unlimited && typeof unlimited === 'object' ? unlimited : {};
  const durations = UNLIMITED_HOURS.map((hours) => {
    const stored = (Array.isArray(source.durations) ? source.durations : []).find((item) => Number(item?.hours) === hours) || {};
    const price = stored.priceIdr === null || stored.priceIdr === undefined ? null : Number(stored.priceIdr);
    const priceIdr = Number.isSafeInteger(price) && price > 0 && price <= MAX_PRICE_IDR ? price : null;
    // A duration without a price can never be on sale.
    return { hours, priceIdr, active: stored.active === true && priceIdr !== null };
  });
  const limits = { ...DEFAULT_UNLIMITED.limits };
  for (const [key, rule] of Object.entries(UNLIMITED_LIMIT_RULES)) {
    const value = Number(source.limits?.[key]);
    if (Number.isSafeInteger(value) && value >= rule.min && value <= rule.max) limits[key] = value;
  }
  const models = [...new Set((Array.isArray(source.models) ? source.models : []).map(modelKey).filter((model) => MODEL_NAME.test(model)))].sort();
  return {
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 60) : DEFAULT_UNLIMITED.name,
    saleEnabled: source.saleEnabled === true,
    durations,
    models,
    limits,
  };
}

// Effective configuration = defaults + the admin's stored overrides, validated.
function buildConfig(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  const rates = {};
  for (const [model, entry] of Object.entries({ ...DEFAULT_RATES, ...(source.rates && typeof source.rates === 'object' ? source.rates : {}) })) {
    const key = modelKey(model);
    if (MODEL_NAME.test(key)) rates[key] = normalizeRate(entry);
  }
  return {
    version: Number.isSafeInteger(source.version) ? source.version : 0,
    updatedAt: source.updatedAt || null,
    packages: normalizePackages(source.packages ?? DEFAULT_PACKAGES),
    rates,
    routing: normalizeRouting(source.routing),
    limits: normalizeLimits(source.limits),
    billing: normalizeBilling(source.billing),
    unlimited: normalizeUnlimited(source.unlimited),
  };
}

// ---------- Rate resolution ----------

function rateUnits(entry) {
  const base = parseMultiplier(entry.multiplier);
  return {
    input: entry.input ? parseMultiplier(entry.input) : base,
    cachedInput: entry.cachedInput ? parseMultiplier(entry.cachedInput) : (entry.input ? parseMultiplier(entry.input) : base),
    output: entry.output ? parseMultiplier(entry.output) : base,
  };
}

// What a request for `model` through `provider` costs, as a snapshot that is stored with the
// reservation (later admin changes never touch a request already running).
// { ok: true, snapshot } or { ok: false, status: 'pending', reason }.
// Mapping is always explicit: provider routing, then alias / effort targets. Nothing is inferred
// from a model's name.
function resolveRate(config, { model, provider = 'default', effort = '' } = {}) {
  const requested = modelKey(model);
  const providerKey = String(provider || 'default').toLowerCase();
  const effortKey = String(effort || '').trim().toLowerCase();
  const fail = (reason) => ({ ok: false, status: 'pending', model: requested, reason });
  if (!requested) return fail('Model tidak diketahui');
  const routedTo = config.routing?.[providerKey]?.[requested] || null;
  const chain = [requested];
  let current = routedTo || requested;
  if (routedTo) chain.push(routedTo);
  let toolCallCredits = 0;
  let toolPriceSource = null;
  for (let depth = 0; depth < 6; depth += 1) {
    const entry = config.rates[current];
    if (!entry) return fail(`Model '${current}' belum punya tarif kredit (menunggu konfigurasi)`);
    if (entry.status === 'pending') return fail(`Tarif '${current}' menunggu konfigurasi admin`);
    if (entry.status === 'alias') {
      if (entry.requiresToolPrice && entry.toolCallCredits === null && !toolPriceSource) {
        return fail(`Biaya tool untuk '${current}' belum diatur`);
      }
      if (!toolPriceSource && entry.toolCallCredits !== null) {
        toolCallCredits = entry.toolCallCredits;
        toolPriceSource = current;
      }
      const next = (effortKey && entry.effortTargets?.[effortKey]) || entry.target;
      if (!next) return fail(`Alias '${current}' belum dipetakan ke model tujuan (menunggu konfigurasi)`);
      if (chain.includes(next)) return fail(`Mapping alias '${current}' melingkar`);
      chain.push(next);
      current = next;
      continue;
    }
    const units = rateUnits(entry);
    return {
      ok: true,
      snapshot: {
        requestedModel: requested,
        provider: providerKey,
        routedTo,
        rateModel: current,
        chain,
        effort: effortKey || null,
        multiplier: entry.multiplier,
        units,
        toolCallCredits,
        configVersion: config.version,
      },
    };
  }
  return fail(`Mapping alias '${requested}' terlalu dalam`);
}

// ---------- Admin commands ----------
// One command per line (the bot accepts several lines in one message). Returns
// { kind: 'config', change } | { kind: 'adjust' | 'refund', userId, amount, reason }
// | { kind: 'confirmOrder', orderId } | { error }.
const ADMIN_COMMAND_HELP = [
  'paket <id> <kredit> <harga>      contoh: paket kredit-10m 10000000 4000',
  'paket <id> on | off | hapus',
  'tarif <model> <multiplier>        contoh: tarif glm-5v-turbo 1.5',
  'tarif <model> pending',
  'tarif <model> input|cache|output <multiplier | default>',
  'alias <model> <tujuan | ->        contoh: alias claude claude-sonnet-4-6',
  'effort <model> <effort> <tujuan | ->',
  'tool <model> <kredit per tool call>',
  'route <provider> <model> <tujuan | ->   contoh: route cbcn deepseek-v4-flash deepseek-v4.1-flash',
  'batas <nama> <nilai>   (output_default, output_min, input_buffer, max_tokens_field, ttl, orphan, tool_reserve)',
  'billing <jual_kredit | legacy_rupiah | legacy_topup> on | off',
  'unlimited jual on | off',
  'unlimited harga <jam> <harga | ->',
  'unlimited <jam> on | off',
  'unlimited model tambah | hapus <model> [model ...]',
  'unlimited batas <concurrency | rpm | output> <nilai>',
  'unlimited nama <teks>',
  'kredit <id user> <+jumlah | -jumlah> [alasan]',
  'refund <id user> <jumlah> [alasan]',
  'order <order id> konfirmasi',
];

// "10000000", "10.000.000", "10jt", "10m", "25rb", "25k" -> integer; null when not a number.
function parseAmount(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/^rp/, '');
  const match = raw.match(/^(\d+(?:[.,]\d+)*)\s*(jt|juta|m|rb|ribu|k)?$/);
  if (!match) return null;
  const unit = match[2];
  let number;
  if (unit) {
    number = Number(match[1].replace(',', '.')) * ({ jt: 1e6, juta: 1e6, m: 1e6, rb: 1e3, ribu: 1e3, k: 1e3 }[unit]);
  } else {
    number = Number(match[1].replace(/[.,]/g, ''));
  }
  return Number.isSafeInteger(Math.round(number)) && Number.isFinite(number) ? Math.round(number) : null;
}

function onOff(word) {
  const value = String(word || '').toLowerCase();
  if (['on', 'aktif', 'buka', 'ya', 'true'].includes(value)) return true;
  if (['off', 'nonaktif', 'tutup', 'tidak', 'false'].includes(value)) return false;
  return null;
}

function parseAdminCommand(line) {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Perintah kosong' };
  const [command, ...args] = words;
  const word = command.toLowerCase();
  const err = (message) => ({ error: message });
  const isClear = (value) => ['-', 'hapus', 'none', 'default'].includes(String(value || '').toLowerCase());

  if (word === 'paket') {
    const id = String(args[0] || '').toLowerCase();
    if (!PACKAGE_ID.test(id)) return err('ID paket tidak valid (huruf kecil, angka, tanda -)');
    if (args.length === 2 && String(args[1]).toLowerCase() === 'hapus') return { kind: 'config', change: { op: 'removePackage', id } };
    if (args.length === 2 && onOff(args[1]) !== null) return { kind: 'config', change: { op: 'setPackageActive', id, active: onOff(args[1]) } };
    if (args.length === 3) {
      const credits = parseAmount(args[1]);
      const priceIdr = parseAmount(args[2]);
      if (!credits || !priceIdr) return err('Format: paket <id> <kredit> <harga>');
      return { kind: 'config', change: { op: 'setPackage', id, credits, priceIdr } };
    }
    return err('Format: paket <id> <kredit> <harga> | paket <id> on/off/hapus');
  }
  if (word === 'tarif') {
    const model = modelKey(args[0]);
    if (!MODEL_NAME.test(model)) return err('Nama model tidak valid');
    if (args.length === 2 && String(args[1]).toLowerCase() === 'pending') return { kind: 'config', change: { op: 'setRatePending', model } };
    if (args.length === 2) return { kind: 'config', change: { op: 'setRate', model, multiplier: args[1] } };
    if (args.length === 3) {
      const part = { input: 'input', cache: 'cachedInput', cached: 'cachedInput', output: 'output' }[String(args[1]).toLowerCase()];
      if (!part) return err('Komponen harus input, cache, atau output');
      return { kind: 'config', change: { op: 'setRateComponent', model, part, multiplier: isClear(args[2]) ? null : args[2] } };
    }
    return err('Format: tarif <model> <multiplier> | tarif <model> pending | tarif <model> input|cache|output <multiplier>');
  }
  if (word === 'alias') {
    const model = modelKey(args[0]);
    if (!MODEL_NAME.test(model) || args.length !== 2) return err('Format: alias <model> <tujuan | ->');
    return { kind: 'config', change: { op: 'setAlias', model, target: isClear(args[1]) ? null : modelKey(args[1]) } };
  }
  if (word === 'effort') {
    const model = modelKey(args[0]);
    const effort = String(args[1] || '').toLowerCase();
    if (!MODEL_NAME.test(model) || !EFFORT_NAME.test(effort) || args.length !== 3) return err('Format: effort <model> <effort> <tujuan | ->');
    return { kind: 'config', change: { op: 'setEffort', model, effort, target: isClear(args[2]) ? null : modelKey(args[2]) } };
  }
  if (word === 'tool') {
    const model = modelKey(args[0]);
    const credits = isClear(args[1]) ? null : parseAmount(args[1]);
    if (!MODEL_NAME.test(model) || args.length !== 2 || (credits === null && !isClear(args[1]))) return err('Format: tool <model> <kredit per tool call>');
    return { kind: 'config', change: { op: 'setToolPrice', model, credits } };
  }
  if (word === 'route') {
    const provider = String(args[0] || '').toLowerCase();
    const model = modelKey(args[1]);
    if (!PROVIDER_NAME.test(provider) || !MODEL_NAME.test(model) || args.length !== 3) return err('Format: route <provider> <model> <tujuan | ->');
    return { kind: 'config', change: { op: 'setRouting', provider, model, target: isClear(args[2]) ? null : modelKey(args[2]) } };
  }
  if (word === 'batas') {
    const key = LIMIT_ALIASES[String(args[0] || '').toLowerCase()] || args[0];
    if (!LIMIT_RULES[key] || args.length !== 2) return err(`Format: batas <${Object.keys(LIMIT_ALIASES).join(' | ')}> <nilai>`);
    let value = LIMIT_RULES[key].type === 'int' ? parseAmount(args[1]) : String(args[1]).toLowerCase();
    if (key === 'orphanPolicy' && value === 'charge') value = 'charge_input_estimate';
    return { kind: 'config', change: { op: 'setLimit', key, value } };
  }
  if (word === 'billing') {
    const key = BILLING_ALIASES[String(args[0] || '').toLowerCase()];
    const value = onOff(args[1]);
    if (!key || value === null || args.length !== 2) return err(`Format: billing <${Object.keys(BILLING_ALIASES).join(' | ')}> on|off`);
    return { kind: 'config', change: { op: 'setBilling', key, value } };
  }
  if (word === 'unlimited') {
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'jual' && onOff(args[1]) !== null && args.length === 2) return { kind: 'config', change: { op: 'setUnlimitedSale', enabled: onOff(args[1]) } };
    if (sub === 'harga' && args.length === 3) {
      const hours = Number(String(args[1]).replace(/(jam|h)$/i, ''));
      const priceIdr = isClear(args[2]) ? null : parseAmount(args[2]);
      if (!UNLIMITED_HOURS.includes(hours) || (priceIdr === null && !isClear(args[2]))) return err(`Format: unlimited harga <${UNLIMITED_HOURS.join('|')}> <harga | ->`);
      return { kind: 'config', change: { op: 'setUnlimitedPrice', hours, priceIdr } };
    }
    if (/^\d+(jam|h)?$/i.test(sub) && args.length === 2 && onOff(args[1]) !== null) {
      const hours = Number(sub.replace(/(jam|h)$/i, ''));
      if (!UNLIMITED_HOURS.includes(hours)) return err(`Durasi harus salah satu dari ${UNLIMITED_HOURS.join(', ')} jam`);
      return { kind: 'config', change: { op: 'setUnlimitedDuration', hours, active: onOff(args[1]) } };
    }
    if (sub === 'model' && ['tambah', 'hapus', 'add', 'remove'].includes(String(args[1] || '').toLowerCase()) && args.length >= 3) {
      const models = args.slice(2).map(modelKey);
      if (models.some((model) => !MODEL_NAME.test(model))) return err('Nama model tidak valid');
      return { kind: 'config', change: { op: 'setUnlimitedModels', action: ['tambah', 'add'].includes(String(args[1]).toLowerCase()) ? 'add' : 'remove', models } };
    }
    if (sub === 'batas' && args.length === 3) {
      const key = UNLIMITED_LIMIT_ALIASES[String(args[1]).toLowerCase()];
      const value = parseAmount(args[2]);
      if (!key || value === null) return err('Format: unlimited batas <concurrency | rpm | output> <nilai>');
      return { kind: 'config', change: { op: 'setUnlimitedLimit', key, value } };
    }
    if (sub === 'nama' && args.length >= 2) return { kind: 'config', change: { op: 'setUnlimitedName', name: args.slice(1).join(' ') } };
    return err('Perintah unlimited tidak dikenal. Lihat bantuan.');
  }
  if (word === 'kredit' || word === 'refund') {
    const userId = String(args[0] || '');
    const signed = String(args[1] || '');
    const amount = parseAmount(signed.replace(/^[+-]/, ''));
    if (!/^\d{1,20}$/.test(userId) || !amount) return err(`Format: ${word} <id user> <${word === 'kredit' ? '+/-' : ''}jumlah> [alasan]`);
    if (word === 'kredit' && !/^[+-]/.test(signed)) return err('Tulis tanda + atau - di depan jumlah, contoh: kredit 123 +1000000 bonus');
    const reason = args.slice(2).join(' ').slice(0, 200);
    if (word === 'refund') return { kind: 'refund', userId, amount, reason };
    return { kind: 'adjust', userId, amount: signed.startsWith('-') ? -amount : amount, reason };
  }
  if (word === 'order') {
    const orderId = String(args[0] || '');
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(orderId) || !['konfirmasi', 'confirm'].includes(String(args[1] || '').toLowerCase())) return err('Format: order <order id> konfirmasi');
    return { kind: 'confirmOrder', orderId };
  }
  return err(`Perintah '${command.slice(0, 20)}' tidak dikenal.`);
}

// Applies one validated change to the stored overrides (pure: returns a new object, throws a
// readable reason when the change is not acceptable). `config` = the current effective config.
function applyConfigChange(overrides, change, config) {
  const next = JSON.parse(JSON.stringify(overrides && typeof overrides === 'object' ? overrides : {}));
  const rates = { ...(next.rates || {}) };
  const effectiveRate = (model) => JSON.parse(JSON.stringify(config.rates[model] || { status: 'pending' }));
  const requireModel = (model) => {
    if (!MODEL_NAME.test(model)) throw new Error('Nama model tidak valid');
  };
  const checkResolvable = (candidateRates) => {
    // Rejects a mapping loop right away (resolution would also refuse it, per request).
    const trial = buildConfig({ ...next, rates: candidateRates });
    for (const [model, entry] of Object.entries(trial.rates)) {
      if (entry.status !== 'alias') continue;
      const seen = new Set([model]);
      let current = entry.target;
      while (current && trial.rates[current]?.status === 'alias') {
        if (seen.has(current)) throw new Error(`Mapping alias melingkar: ${[...seen, current].join(' -> ')}`);
        seen.add(current);
        current = trial.rates[current].target;
      }
    }
  };
  switch (change?.op) {
    case 'setPackage': {
      const id = String(change.id || '').toLowerCase();
      const credits = Number(change.credits);
      const priceIdr = Number(change.priceIdr);
      if (!PACKAGE_ID.test(id)) throw new Error('ID paket tidak valid');
      if (!Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_PACKAGE_CREDITS) throw new Error('Jumlah kredit tidak valid');
      if (!Number.isSafeInteger(priceIdr) || priceIdr <= 0 || priceIdr > MAX_PRICE_IDR) throw new Error('Harga harus Rp1 sampai Rp100.000.000');
      const packages = config.packages.filter((item) => item.id !== id);
      const existing = config.packages.find((item) => item.id === id);
      next.packages = [...packages, { id, credits, priceIdr, active: existing ? existing.active : true }];
      break;
    }
    case 'setPackageActive':
    case 'removePackage': {
      const id = String(change.id || '').toLowerCase();
      if (!config.packages.some((item) => item.id === id)) throw new Error(`Paket '${id}' tidak ada`);
      next.packages = change.op === 'removePackage'
        ? config.packages.filter((item) => item.id !== id)
        : config.packages.map((item) => (item.id === id ? { ...item, active: Boolean(change.active) } : item));
      break;
    }
    case 'setRate': {
      requireModel(change.model);
      const units = parseMultiplier(change.multiplier);
      const previous = config.rates[change.model];
      rates[change.model] = { status: 'active', multiplier: formatMultiplier(units), ...(previous?.type ? { type: previous.type } : {}) };
      break;
    }
    case 'setRatePending':
      requireModel(change.model);
      rates[change.model] = { status: 'pending', note: 'Diatur admin: menunggu konfigurasi' };
      break;
    case 'setRateComponent': {
      requireModel(change.model);
      const entry = effectiveRate(change.model);
      if (entry.status !== 'active') throw new Error(`Atur multiplier dasar '${change.model}' dulu (tarif <model> <multiplier>)`);
      if (!['input', 'cachedInput', 'output'].includes(change.part)) throw new Error('Komponen tidak valid');
      if (change.multiplier === null) delete entry[change.part];
      else entry[change.part] = formatMultiplier(parseMultiplier(change.multiplier));
      rates[change.model] = entry;
      break;
    }
    case 'setAlias':
    case 'setEffort':
    case 'setToolPrice': {
      requireModel(change.model);
      const current = effectiveRate(change.model);
      const entry = current.status === 'alias' ? current : { status: 'alias', target: null, effortTargets: {}, requiresToolPrice: false, toolCallCredits: null };
      if (change.op === 'setAlias') {
        if (change.target !== null) {
          requireModel(change.target);
          if (change.target === change.model) throw new Error('Alias tidak boleh menunjuk dirinya sendiri');
          if (!config.rates[change.target]) throw new Error(`Model tujuan '${change.target}' belum ada di daftar tarif`);
        }
        entry.target = change.target;
      } else if (change.op === 'setEffort') {
        entry.effortTargets = { ...(entry.effortTargets || {}) };
        if (change.target === null) delete entry.effortTargets[change.effort];
        else {
          requireModel(change.target);
          if (!config.rates[change.target]) throw new Error(`Model tujuan '${change.target}' belum ada di daftar tarif`);
          entry.effortTargets[change.effort] = change.target;
        }
      } else {
        const credits = change.credits === null ? null : Number(change.credits);
        if (credits !== null && (!Number.isSafeInteger(credits) || credits < 0 || credits > MAX_TOOL_CALL_CREDITS)) throw new Error('Biaya tool tidak valid');
        entry.toolCallCredits = credits;
      }
      rates[change.model] = entry;
      checkResolvable(rates);
      break;
    }
    case 'setRouting': {
      const provider = String(change.provider || '').toLowerCase();
      if (!PROVIDER_NAME.test(provider)) throw new Error('Nama provider tidak valid');
      requireModel(change.model);
      const routing = JSON.parse(JSON.stringify(config.routing));
      routing[provider] = { ...(routing[provider] || {}) };
      if (change.target === null) delete routing[provider][change.model];
      else {
        requireModel(change.target);
        if (change.target === change.model) throw new Error('Tujuan routing sama dengan modelnya');
        if (!config.rates[change.target]) throw new Error(`Model tujuan '${change.target}' belum ada di daftar tarif`);
        routing[provider][change.model] = change.target;
      }
      if (!Object.keys(routing[provider]).length) delete routing[provider];
      next.routing = routing;
      break;
    }
    case 'setLimit': {
      const clean = normalizeLimitValue(change.key, change.value);
      if (clean === undefined) {
        const rule = LIMIT_RULES[change.key];
        throw new Error(rule ? `Nilai ${change.key} tidak valid (${rule.type === 'enum' ? rule.values.join(' / ') : `${rule.min}-${rule.max}`})` : 'Nama batas tidak dikenal');
      }
      next.limits = { ...(next.limits || {}), [change.key]: clean };
      break;
    }
    case 'setBilling':
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_BILLING, change.key) || typeof change.value !== 'boolean') throw new Error('Pengaturan billing tidak dikenal');
      next.billing = { ...(next.billing || {}), [change.key]: change.value };
      break;
    case 'setUnlimitedSale':
    case 'setUnlimitedPrice':
    case 'setUnlimitedDuration':
    case 'setUnlimitedModels':
    case 'setUnlimitedLimit':
    case 'setUnlimitedName': {
      const unlimited = JSON.parse(JSON.stringify(config.unlimited));
      if (change.op === 'setUnlimitedSale') {
        if (change.enabled && !unlimited.durations.some((item) => item.priceIdr !== null)) throw new Error('Tetapkan harga minimal satu durasi dulu (unlimited harga <jam> <harga>)');
        if (change.enabled && !unlimited.models.length) throw new Error('Tambahkan model yang termasuk paket dulu (unlimited model tambah <model>)');
        unlimited.saleEnabled = Boolean(change.enabled);
      } else if (change.op === 'setUnlimitedPrice' || change.op === 'setUnlimitedDuration') {
        const duration = unlimited.durations.find((item) => item.hours === Number(change.hours));
        if (!duration) throw new Error('Durasi tidak dikenal');
        if (change.op === 'setUnlimitedPrice') {
          const price = change.priceIdr === null ? null : Number(change.priceIdr);
          if (price !== null && (!Number.isSafeInteger(price) || price <= 0 || price > MAX_PRICE_IDR)) throw new Error('Harga harus Rp1 sampai Rp100.000.000');
          duration.priceIdr = price;
          if (price === null) duration.active = false;
        } else {
          if (change.active && duration.priceIdr === null) throw new Error(`Tetapkan harga paket ${duration.hours} jam dulu`);
          duration.active = Boolean(change.active);
        }
      } else if (change.op === 'setUnlimitedModels') {
        const models = new Set(unlimited.models);
        for (const model of change.models || []) {
          requireModel(model);
          if (change.action === 'add') models.add(model);
          else models.delete(model);
        }
        unlimited.models = [...models].sort();
      } else if (change.op === 'setUnlimitedLimit') {
        const rule = UNLIMITED_LIMIT_RULES[change.key];
        const value = Number(change.value);
        if (!rule || !Number.isSafeInteger(value) || value < rule.min || value > rule.max) throw new Error(`Nilai tidak valid (${rule ? `${rule.min}-${rule.max}` : '?'})`);
        unlimited.limits[change.key] = value;
      } else {
        const name = String(change.name || '').trim();
        if (!name || name.length > 60) throw new Error('Nama paket 1-60 karakter');
        unlimited.name = name;
      }
      next.unlimited = unlimited;
      break;
    }
    default:
      throw new Error('Perubahan tidak dikenal');
  }
  if (Object.keys(rates).length) next.rates = rates;
  return next;
}

// Short human summary of a change, for the audit log.
function describeChange(change) {
  const parts = Object.entries(change || {}).filter(([key]) => key !== 'op').map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`);
  return `${change?.op || '?'} ${parts.join(' ')}`.trim().slice(0, 300);
}

module.exports = {
  MULTIPLIER_SCALE, MAX_CREDITS, UNLIMITED_HOURS, MODEL_NAME,
  DEFAULT_RATES, DEFAULT_PACKAGES, DEFAULT_LIMITS, DEFAULT_BILLING, DEFAULT_UNLIMITED, ADMIN_COMMAND_HELP,
  parseMultiplier, formatMultiplier, computeCredits, affordableOutputTokens, tokensForCredits, isSafeCount,
  normalizeUsage, mergeUsage, modelKey, providerOf, buildConfig, resolveRate,
  parseAmount, parseAdminCommand, applyConfigChange, describeChange,
};

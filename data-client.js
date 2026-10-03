// Data access for the Telegram bot.
//
// Same host as server.js (DATA_API_URL not set): reads/writes the local
// data/ files directly, exactly like before.
//
// Different hosts (DATA_API_URL set): every call goes to server.js's
// /internal/rpc endpoint, so API keys, balances, redeem codes, tickets and
// settings live in ONE database on the API server. That is what makes an API
// key created in the bot valid in the API.
//
// Every function here is async in both modes.
const crypto = require('crypto');

const DATA_API_URL = String(process.env.DATA_API_URL || '').trim().replace(/\/+$/, '');
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const REQUEST_TIMEOUT_MS = 15_000;

const FUNCTION_NAMES = [
  'ensureUser', 'setUserLanguage', 'createApiKey', 'getUser', 'getAllUsers', 'getAdminLogs', 'adjustBalance', 'getOrder', 'revokeApiKey',
  'createOrder', 'settleOrder', 'createRedeemCode', 'redeemCode', 'listRedeemCodes', 'disableRedeemCode', 'getAdminStats', 'resetStats',
  'getReferralInfo', 'startWithReferral', 'getReferralSettings', 'setReferralSettings',
  'createTicket', 'addTicketMessage', 'linkAdminMessage', 'findTicketByAdminMessage', 'getTicket', 'getOpenTicketForUser',
  'listTickets', 'countOpenTickets', 'closeTicket',
  'createPoll', 'votePoll', 'getPoll', 'listPolls', 'closePoll', 'setPollSent',
  'listPromptUsers', 'getUserPrompts', 'clearPrompts', 'clearAllPrompts', 'isPromptLogEnabled', 'setPromptLogEnabled',
  'readSettings', 'isAllModelsFree', 'setAllModelsFree', 'isPaymentsEnabled', 'setPaymentsEnabled', 'setAnnouncement',
  'getDisabledModels', 'setModelDisabled', 'setFamilyDisabled',
  'getRateLimits', 'setModelRateLimit', 'setFamilyRateLimit',
  'listBansos', 'createBansos', 'stopBansos',
  'getModerationSettings', 'setModerationSettings', 'listModerationBlocks', 'getModerationBlock', 'clearModerationBlocks',
  'saveModelCache',
];

const remote = Boolean(DATA_API_URL);
if (remote && !INTERNAL_API_SECRET) {
  console.error('DATA_API_URL is set but INTERNAL_API_SECRET is not. Set the same INTERNAL_API_SECRET on the bot and the API server.');
  process.exit(1);
}

async function callRemote(fn, args) {
  // JSON turns a trailing `undefined` into `null`, which would defeat default
  // parameters on the server, so drop trailing undefined arguments.
  const trimmed = [...args];
  while (trimmed.length && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
  const body = JSON.stringify({ fn, args: trimmed });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', INTERNAL_API_SECRET).update(`${timestamp}.`).update(body).digest('hex');
  let response;
  try {
    response = await fetch(`${DATA_API_URL}/internal/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message || '';
    const hints = {
      ECONNREFUSED: 'nothing is listening at that address from the bot host (wrong port, or server.js bound to 127.0.0.1)',
      ETIMEDOUT: 'connection timed out: the bot host cannot reach that IP/port (firewall, or the host cannot call its own public IP)',
      UND_ERR_CONNECT_TIMEOUT: 'connection timed out: the bot host cannot reach that IP/port (firewall, or the host cannot call its own public IP)',
      EHOSTUNREACH: 'no route from the bot host to that IP',
      ENOTFOUND: 'host name does not resolve',
    };
    const detail = cause ? ` [${cause}${hints[cause] ? `: ${hints[cause]}` : ''}]` : '';
    throw new Error(`Data API unreachable (${DATA_API_URL}): ${error.message}${detail}`);
  }
  let result;
  try {
    result = await response.json();
  } catch (_) {
    throw new Error(`Data API returned HTTP ${response.status} (is DATA_API_URL pointing at server.js?)`);
  }
  if (!response.ok || !result.ok) {
    const hint = response.status === 401 ? ' — INTERNAL_API_SECRET differs between bot and server, or the clocks are more than 5 minutes apart'
      : response.status === 404 ? ' — set INTERNAL_API_SECRET on the API server' : '';
    throw new Error(`Data API ${fn} failed: ${result.error || response.status}${hint}`);
  }
  return result.result;
}

function buildLocal() {
  const fs = require('fs');
  const path = require('path');
  const usageDb = require('./usage-db');
  const adminSettings = require('./admin-settings');
  const local = {
    ...usageDb,
    ...adminSettings,
    saveModelCache: (cache) => {
      const cachePath = path.join(__dirname, 'data', 'models.json');
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
      return true;
    },
  };
  return Object.fromEntries(FUNCTION_NAMES.map((name) => [name, async (...args) => local[name](...args)]));
}

function buildRemote() {
  return Object.fromEntries(FUNCTION_NAMES.map((name) => [name, (...args) => callRemote(name, args)]));
}

module.exports = { ...(remote ? buildRemote() : buildLocal()), dataMode: remote ? `remote (${DATA_API_URL})` : 'local files' };

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBillingPrice } = require('./pricing');

const configuredDatabasePath = process.env.USAGE_DB_PATH;
const databasePath = configuredDatabasePath
  ? (path.isAbsolute(configuredDatabasePath) ? configuredDatabasePath : path.resolve(__dirname, configuredDatabasePath))
  : path.join(__dirname, 'data', 'users.json');
const lockPath = `${databasePath}.lock`;

function emptyDatabase() {
  return { users: {}, adminLogs: [] };
}

function readDatabase() {
  try {
    return JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDatabase();
    throw new Error(`Database read failed; refusing to reset data: ${error.message}`);
  }
}

function writeDatabaseUnlocked(database) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2), 'utf8');
  if (fs.existsSync(databasePath)) fs.copyFileSync(databasePath, `${databasePath}.bak`);
  fs.renameSync(temporaryPath, databasePath);
}

function waitBriefly() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
}

function mutateDatabase(mutator) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let lockHandle;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      lockHandle = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      waitBriefly();
    }
  }
  if (!lockHandle) throw new Error('Database is busy; try again');
  try {
    const database = readDatabase();
    const result = mutator(database);
    writeDatabaseUnlocked(database);
    return result;
  } finally {
    fs.closeSync(lockHandle);
    fs.unlinkSync(lockPath);
  }
}

function newUser(telegramId, profile = {}) {
  return {
    telegramId: String(telegramId),
    username: profile.username || '',
    firstName: profile.firstName || '',
    createdAt: new Date().toISOString(),
    apiKeys: [],
    balance: 0,
    orders: [],
    stats: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errors: 0, spent: 0 },
    logs: [],
  };
}

function createOrder(telegramId, order) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id);
    user.orders.push({ ...order, createdAt: new Date().toISOString(), status: 'PENDING' });
    user.orders = user.orders.slice(-50);
    database.users[id] = user;
    return user.orders[user.orders.length - 1];
  });
}

function settleOrder(orderId, amount) {
  return mutateDatabase((database) => {
    for (const user of Object.values(database.users)) {
      const order = user.orders.find((entry) => entry.orderId === orderId);
      if (!order) continue;
      if (order.status === 'SETTLED') return { settled: false, userId: user.telegramId, balance: user.balance };
      order.status = 'SETTLED';
      order.settledAt = new Date().toISOString();
      order.paidAmount = Number(amount || order.amount);
      user.balance += Number(order.amount);
      return { settled: true, userId: user.telegramId, balance: user.balance };
    }
    return null;
  });
}

function ensureUser(telegramId, profile = {}) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    Object.assign(user, { username: profile.username || user.username, firstName: profile.firstName || user.firstName });
    database.users[id] = user;
    return user;
  });
}

function createApiKey(telegramId, profile = {}) {
  return mutateDatabase((database) => {
    const id = String(telegramId);
    const user = database.users[id] || newUser(id, profile);
    const key = `sk-user-${crypto.randomBytes(24).toString('hex')}`;
    user.apiKeys.push({ key, createdAt: new Date().toISOString(), active: true });
    database.users[id] = user;
    return key;
  });
}

function findUserByApiKey(apiKey) {
  if (!apiKey) return null;
  const database = readDatabase();
  for (const user of Object.values(database.users)) {
    if (user.apiKeys.some((entry) => entry.key === apiKey && entry.active !== false)) return user;
  }
  return null;
}

function recordUsage(apiKey, usage = {}) {
  return mutateDatabase((database) => {
    let owner;
    for (const user of Object.values(database.users)) {
      if (user.apiKeys.some((entry) => entry.key === apiKey && entry.active !== false)) {
        owner = user;
        break;
      }
    }
    if (!owner) return false;

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const statusCode = Number(usage.statusCode || 200);
  const totalTokens = inputTokens + outputTokens;
  const pricePerMillion = Number(usage.pricePerMillion ?? getBillingPrice(usage.model));
  const cost = pricePerMillion ? (totalTokens / 1_000_000) * pricePerMillion : 0;
  owner.stats.requests += 1;
  owner.stats.inputTokens += inputTokens;
  owner.stats.outputTokens += outputTokens;
  owner.stats.totalTokens += totalTokens;
  owner.stats.spent = Number(owner.stats.spent || 0) + cost;
  owner.balance = Math.max(0, Number(owner.balance || 0) - cost);
  if (statusCode >= 400) owner.stats.errors += 1;
  owner.lastUsedAt = new Date().toISOString();
  owner.logs.push({
    at: owner.lastUsedAt,
    endpoint: usage.endpoint || '',
    status: statusCode,
    inputTokens,
    outputTokens,
    model: usage.model || '',
    pricePerMillion,
    cost,
  });
  owner.logs = owner.logs.slice(-50);
    return true;
  });
}

function getUser(telegramId) {
  return readDatabase().users[String(telegramId)] || null;
}

function getAllUsers() {
  return Object.values(readDatabase().users);
}

function recordAdminRequest(log) {
  mutateDatabase((database) => {
    database.adminLogs = Array.isArray(database.adminLogs) ? database.adminLogs : [];
    database.adminLogs.push({ at: new Date().toISOString(), ...log });
    database.adminLogs = database.adminLogs.slice(-500);
  });
}

function getAdminLogs(limit = 50) {
  const database = readDatabase();
  return (database.adminLogs || []).slice(-Number(limit)).reverse();
}

function addBalance(telegramId, amount) {
  return adjustBalance(telegramId, Math.abs(Number(amount)));
}

function adjustBalance(telegramId, delta) {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return null;
  return mutateDatabase((database) => {
    const user = database.users[String(telegramId)];
    if (!user) return null;
    user.balance = Math.max(0, Number(user.balance || 0) + value);
    user.lastBalanceTopUpAt = new Date().toISOString();
    return user.balance;
  });
}

function getOrder(telegramId, orderId) {
  const user = getUser(telegramId);
  return user?.orders.find((order) => order.orderId === orderId) || null;
}

function revokeApiKey(telegramId, index) {
  return mutateDatabase((database) => {
    const user = database.users[String(telegramId)];
    if (!user) return null;
    const activeKeys = user.apiKeys.filter((entry) => entry.active !== false);
    const key = activeKeys[Number(index)];
    if (!key) return null;
    key.active = false;
    key.revokedAt = new Date().toISOString();
    return key.key;
  });
}

module.exports = { ensureUser, createApiKey, findUserByApiKey, recordUsage, getUser, getAllUsers, recordAdminRequest, getAdminLogs, addBalance, adjustBalance, getOrder, revokeApiKey, createOrder, settleOrder, databasePath };

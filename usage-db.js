const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const databasePath = path.resolve(process.env.USAGE_DB_PATH || path.join(__dirname, 'data', 'users.json'));

function emptyDatabase() {
  return { users: {} };
}

function readDatabase() {
  try {
    return JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[database] read failed:', error.message);
    return emptyDatabase();
  }
}

function writeDatabase(database) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2), 'utf8');
  fs.renameSync(temporaryPath, databasePath);
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
    stats: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errors: 0 },
    logs: [],
  };
}

function createOrder(telegramId, order) {
  const database = readDatabase();
  const id = String(telegramId);
  const user = database.users[id] || newUser(id);
  user.orders.push({ ...order, createdAt: new Date().toISOString(), status: 'PENDING' });
  user.orders = user.orders.slice(-50);
  database.users[id] = user;
  writeDatabase(database);
  return user.orders[user.orders.length - 1];
}

function settleOrder(orderId, amount) {
  const database = readDatabase();
  for (const user of Object.values(database.users)) {
    const order = user.orders.find((entry) => entry.orderId === orderId);
    if (!order) continue;
    if (order.status === 'SETTLED') return { settled: false, userId: user.telegramId, balance: user.balance };
    order.status = 'SETTLED';
    order.settledAt = new Date().toISOString();
    order.paidAmount = Number(amount || order.amount);
    user.balance += Number(order.amount);
    writeDatabase(database);
    return { settled: true, userId: user.telegramId, balance: user.balance };
  }
  return null;
}

function ensureUser(telegramId, profile = {}) {
  const database = readDatabase();
  const id = String(telegramId);
  const user = database.users[id] || newUser(id, profile);
  Object.assign(user, {
    username: profile.username || user.username,
    firstName: profile.firstName || user.firstName,
  });
  database.users[id] = user;
  writeDatabase(database);
  return user;
}

function createApiKey(telegramId, profile = {}) {
  const database = readDatabase();
  const id = String(telegramId);
  const user = database.users[id] || newUser(id, profile);
  const key = `sk-user-${crypto.randomBytes(24).toString('hex')}`;
  user.apiKeys.push({ key, createdAt: new Date().toISOString(), active: true });
  database.users[id] = user;
  writeDatabase(database);
  return key;
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
  const database = readDatabase();
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
  owner.stats.requests += 1;
  owner.stats.inputTokens += inputTokens;
  owner.stats.outputTokens += outputTokens;
  owner.stats.totalTokens += inputTokens + outputTokens;
  if (statusCode >= 400) owner.stats.errors += 1;
  owner.lastUsedAt = new Date().toISOString();
  owner.logs.push({
    at: owner.lastUsedAt,
    endpoint: usage.endpoint || '',
    status: statusCode,
    inputTokens,
    outputTokens,
  });
  owner.logs = owner.logs.slice(-50);
  writeDatabase(database);
  return true;
}

function getUser(telegramId) {
  return readDatabase().users[String(telegramId)] || null;
}

function getOrder(telegramId, orderId) {
  const user = getUser(telegramId);
  return user?.orders.find((order) => order.orderId === orderId) || null;
}

module.exports = { ensureUser, createApiKey, findUserByApiKey, recordUsage, getUser, getOrder, createOrder, settleOrder, databasePath };

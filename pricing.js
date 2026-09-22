const MODEL_PRICES = Object.freeze({
  'deepseek-v4-flash': 400,
  'deepseek-v4-flash-0731': 400,
  'deepseek-v4-pro': 450,
  'deepseek-v4-pro-0813': 450,
  'deepseek-v4.1-flash': 400,
  'glm-5.1': 450,
  'glm-5.2': 500,
  'glm-5.3': 650,
  'glm-5.3-flash': 400,
  'glm-5.0-turbo': 400,
  'deepseek-v3.2': 200,
  'deepseek-v3.2-free': 0,
  'gemini-3.1-pro': 250,
  'gemini-3.6-flash': 300,
  'gemini-3.7-flash': 350,
  'gemini-3.8-flash': 400,
  'grok-4.3': 200,
  'grok-4.5': 400,
  'grok-4.6': 800,
  'grok-build-0.1': 250,
  'grok-composer-2.5-fast': 600,
  'hy3': 150,
  'hy3-free': 0,
  'hy4-preview': 200,
  'hy4-preview-free': 0,
  'kimi-k2.5': 350,
  'minimax-m2.7': 300,
  'minimax-m3': 350,
  'qwen-3.5-flash': 200,
  'qwen-3.5-plus': 200,
  'qwen-3.6-flash': 200,
  'qwen-3.6-plus': 200,
  'qwen-3.7-flash': 200,
  'qwen-3.7-max': 300,
  'qwen-3.7-plus': 250,
  'qwen-3.8-flash': 350,
  'qwen-3.8-max': 400,
  'qwen-3.8-max-0902': 400,
});
const { isAllModelsFree } = require('./admin-settings');
const DEFAULT_MODEL_PRICE = Number(process.env.DEFAULT_MODEL_PRICE || 400);
const MODEL_PRICE_MARKUP = Number(process.env.MODEL_PRICE_MARKUP || 1.25);

function applyMarkup(price) {
  if (price === 0) return 0;
  const markedUp = Number(price) * MODEL_PRICE_MARKUP;
  return Math.ceil(markedUp / 50) * 50;
}

function getModelFamily(model) {
  const fullName = String(model || '').toLowerCase();
  const name = fullName.split('/').pop();
  if (name.startsWith('grok-')) return 'Groq';
  if (name.startsWith('qwen-')) return 'Qwen';
  if (name.startsWith('gpt-') || fullName.startsWith('cx/gpt-')) return 'ChatGPT';
  if (name.startsWith('hy')) return 'Hy';
  if (name.startsWith('deepseek-')) return 'DeepSeek';
  if (name.startsWith('glm-')) return 'GLM';
  if (name.startsWith('kimi-')) return 'Kimi';
  if (name.startsWith('gemini-')) return 'Gemini';
  if (name.startsWith('minimax-')) return 'MiniMax';
  return null;
}

function stripModelPrefix(model) {
  return String(model || '').replace(/^(?:1|cx)\//i, '');
}

function getModelPrice(model) {
  if (isAllModelsFree()) return 0;
  const modelName = String(model || '').split('/').pop();
  const basePrice = MODEL_PRICES[modelName];
  return basePrice === undefined ? null : applyMarkup(basePrice);
}

function getBillingPrice(model) {
  if (isAllModelsFree()) return 0;
  const price = getModelPrice(model);
  return price === null ? applyMarkup(DEFAULT_MODEL_PRICE) : price;
}

function tokenAllowance(price, balance = 10000) {
  if (!price) return null;
  return (Number(balance) * 1_000_000) / price;
}

module.exports = { MODEL_PRICES, DEFAULT_MODEL_PRICE, MODEL_PRICE_MARKUP, getModelFamily, stripModelPrefix, getModelPrice, getBillingPrice, tokenAllowance };

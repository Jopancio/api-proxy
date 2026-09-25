require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { findUserByApiKey, recordAdminRequest, recordUsage, settleOrder } = require('./usage-db');
const { getModelFamily, stripModelPrefix } = require('./pricing');
const { isAllModelsFree } = require('./admin-settings');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
// Support both the project-specific name and the name used by OpenAI clients.
const API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
const CASHI_SECRET_KEY = process.env.CASHI_SECRET_KEY;
const modelCachePath = path.join(__dirname, 'data', 'models.json');

if (!UPSTREAM_BASE_URL) {
  console.error('UPSTREAM_BASE_URL is not set. Refusing to start.');
  process.exit(1);
}

const app = express();

// Request logging: method, path, status, response time, response size.
app.use(morgan('dev'));

// Cashi payment webhook. Cashi signs the exact raw request body with HMAC-SHA256.
app.post('/webhooks/cashi', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.get('x-gateway-signature');
  if (!CASHI_SECRET_KEY || !signature || !Buffer.isBuffer(req.body)) {
    return res.status(401).send('Invalid webhook');
  }
  const expected = crypto.createHmac('sha256', CASHI_SECRET_KEY).update(req.body).digest('hex');
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.status(400).send('Invalid JSON');
  }
  if (event.event === 'PAYMENT_SETTLED' && event.data?.status === 'SETTLED') {
    settleOrder(event.data.order_id, event.data.amount);
  }
  return res.send('OK');
});

// OpenAI requests are JSON. Parse them so unsupported model families can be
// rejected before they consume upstream capacity, then restore the body for HPM.
app.use('/v1', (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const usage = req.usageDetails || {};
    recordAdminRequest({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.userRecord?.telegramId || null,
      model: req.body?.model || req.requestModel || null,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      totalTokens: usage.totalTokens || 0,
      pricePerMillion: usage.pricePerMillion || 0,
      cost: usage.cost || 0,
      balanceAfter: usage.balanceAfter,
    });
  });
  next();
});
app.use('/v1', express.json({ limit: '10mb' }));
app.use('/v1', (req, res, next) => {
  const model = req.body && req.body.model;
  if (model && !getModelFamily(model)) {
    return res.status(403).json({
      error: {
        message: `Model '${model}' is not available. Supported families: Groq, Qwen, ChatGPT, Hy, DeepSeek, GLM, Kimi, Gemini, MiniMax.`,
        type: 'model_not_supported',
      },
    });
  }
  if (model && req.body) req.body.model = resolveUpstreamModel(model);
  next();
});

function getClientApiKey(req) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  // OpenCode uses Authorization: Bearer. Some OpenAI-compatible clients use
  // x-api-key, so accept that equivalent header as well.
  return (match && match[1].trim()) || (req.headers['x-api-key'] && String(req.headers['x-api-key']).trim());
}

// Every API request must use an active generated user key.
app.use('/v1', (req, res, next) => {
  const clientApiKey = getClientApiKey(req);
  if (!clientApiKey) return res.status(401).json({ error: { message: 'API key is required', type: 'missing_api_key' } });
  if (!clientApiKey.startsWith('sk-user-')) return res.status(401).json({ error: { message: 'Invalid user API key', type: 'invalid_api_key' } });
  const user = findUserByApiKey(clientApiKey);
  if (!user) return res.status(401).json({ error: { message: 'Invalid or revoked API key', type: 'invalid_api_key' } });
  req.userApiKey = clientApiKey;
  req.userRecord = user;
  const balance = Number(user.balance || 0);
  if (!isAllModelsFree() && (!Number.isFinite(balance) || balance <= 0)) {
    return res.status(402).json({
      error: {
        message: 'Insufficient balance. Please top up your account before using the API.',
        type: 'insufficient_balance',
        code: 'payment_required',
      },
    });
  }
  next();
});

function resolveUpstreamModel(model) {
  const requested = String(model || '');
  try {
    const cache = JSON.parse(fs.readFileSync(modelCachePath, 'utf8'));
    if (cache.aliases?.[requested]) return cache.aliases[requested];
  } catch (_) {
    // The model cache is optional; use the default upstream provider prefix below.
  }
  if (!requested.includes('/')) return `1/${requested}`;
  return requested;
}

// Return a normalized model list so clients see `gpt-6-astra`, not `1/gpt-6-astra`.
app.get('/v1/models', async (_req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM_BASE_URL}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    });
    const payload = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(payload);
    const byDisplayName = new Map();
    for (const model of payload.data || []) {
      if (!model.id) continue;
      const displayName = stripModelPrefix(model.id);
      if (!byDisplayName.has(displayName) || model.id.startsWith('1/')) {
        byDisplayName.set(displayName, { ...model, id: displayName });
      }
    }
    return res.json({ ...payload, data: [...byDisplayName.values()] });
  } catch (error) {
    return res.status(502).json({ error: { message: 'Could not load upstream models', detail: error.message } });
  }
});

// OpenAI-compatible endpoint:
//   client baseURL: http://127.0.0.1:8080/v1
//   request:        POST /v1/chat/completions
//   upstream:       POST <UPSTREAM_BASE_URL>/chat/completions
app.use(
  '/v1',
  createProxyMiddleware({
    target: UPSTREAM_BASE_URL,
    changeOrigin: true,
    // UPSTREAM_BASE_URL already includes the /v1 segment, so strip our
    // local /v1 mount prefix before appending the remainder to the target.
    pathRewrite: { '^/v1': '' },
    logger: console,
    on: {
      proxyReq: (proxyReq, req) => {
        const userApiKey = req.userApiKey || getClientApiKey(req);
        req.userApiKey = userApiKey;

        // Use the configured upstream key when available. This lets OpenAI SDK
        // clients use any local placeholder key while the proxy authenticates
        // with the real upstream credential.
        if (API_KEY) {
          proxyReq.setHeader('Authorization', `Bearer ${API_KEY}`);
        }
        req.requestModel = stripModelPrefix(req.body?.model || '');

        if (req.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
          fixRequestBody(proxyReq, req);
        }

        console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${UPSTREAM_BASE_URL}${req.url}`);
      },
      proxyRes: (proxyRes, req) => {
        if (!req.userApiKey) return;
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let usage = {};
          let model = '';
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const parsed = JSON.parse(body);
              usage = parsed.usage || {};
              model = parsed.model || '';
            } catch (_) {
              // Streaming responses contain one JSON object per SSE data line.
              for (const line of body.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                try {
                  const parsed = JSON.parse(line.slice(5).trim());
                  if (parsed.usage) usage = parsed.usage;
                  if (parsed.model) model = parsed.model;
                } catch (_) { /* Ignore non-JSON keep-alive chunks. */ }
              }
            }
          } catch (_) {
            // Streaming responses and non-JSON errors are still counted as requests.
          }
          const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
          const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
          const billingModel = model || req.requestModel;
          const pricePerMillion = require('./pricing').getBillingPrice(billingModel);
          const totalTokens = Number(inputTokens) + Number(outputTokens);
          const cost = pricePerMillion ? (totalTokens / 1_000_000) * pricePerMillion : 0;
          req.usageDetails = { inputTokens, outputTokens, totalTokens, pricePerMillion, cost };
          recordUsage(req.userApiKey, {
            endpoint: req.originalUrl,
            statusCode: proxyRes.statusCode,
            model: billingModel,
            inputTokens,
            outputTokens,
          });
          const updatedUser = require('./usage-db').findUserByApiKey(req.userApiKey);
          req.usageDetails.balanceAfter = updatedUser?.balance;
        });
      },
      error: (err, req, res) => {
        console.error('[proxy] error:', err.message);
        if (res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'Upstream proxy error', type: 'proxy_error' },
          }));
        }
      },
    },
  })
);

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    upstream: UPSTREAM_BASE_URL,
    authentication: API_KEY ? 'configured' : 'caller-provided',
  });
});

app.listen(PORT, HOST, () => {
  console.log(`OpenAI-compatible API proxy listening on http://${HOST}:${PORT}`);
  console.log(`Forwarding /v1/* -> ${UPSTREAM_BASE_URL}/*`);
});

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { findUserByApiKey, recordUsage, settleOrder } = require('./usage-db');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://sg1-9682fffda636.shinsengumi.my.id/v1';
// Support both the project-specific name and the name used by OpenAI clients.
const API_KEY = process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY;
const CASHI_SECRET_KEY = process.env.CASHI_SECRET_KEY;

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
        const authorization = req.headers.authorization || '';
        const match = authorization.match(/^Bearer\s+(.+)$/i);
        const userApiKey = match && findUserByApiKey(match[1]) ? match[1] : null;
        req.userApiKey = userApiKey;

        // Use the configured upstream key when available. This lets OpenAI SDK
        // clients use any local placeholder key while the proxy authenticates
        // with the real upstream credential.
        if (API_KEY) {
          proxyReq.setHeader('Authorization', `Bearer ${API_KEY}`);
        }

        console.log(`[proxy] ${req.method} ${req.originalUrl} -> ${UPSTREAM_BASE_URL}${req.url}`);
      },
      proxyRes: (proxyRes, req) => {
        if (!req.userApiKey) return;
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          let usage = {};
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body);
            usage = parsed.usage || {};
          } catch (_) {
            // Streaming responses and non-JSON errors are still counted as requests.
          }
          recordUsage(req.userApiKey, {
            endpoint: req.originalUrl,
            statusCode: proxyRes.statusCode,
            inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
          });
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

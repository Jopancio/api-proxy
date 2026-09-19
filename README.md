# api-proxy

Minimal Node.js/Express reverse proxy that forwards requests unchanged to an upstream API.

## What it does

Any request to `http://<HOST>:<PORT>/v1/...` is forwarded to `<UPSTREAM_BASE_URL>/...`
with method, headers, body, and query string preserved, and the upstream's response
(status, headers, body) is returned to the caller unchanged.

## Setup

```powershell
npm install
copy .env.example .env
```

Edit `.env` if you want to override the defaults:

```
HOST=127.0.0.1
PORT=8080
UPSTREAM_BASE_URL=https://sg1-9682fffda636.shinsengumi.my.id/v1
UPSTREAM_API_KEY=your-upstream-api-key
TELEGRAM_BOT_TOKEN=your-botfather-token
CASHI_API_KEY=your-cashi-api-key
CASHI_SECRET_KEY=your-cashi-webhook-secret
```

## Run

```powershell
npm start
```

Run the Telegram bot in a separate terminal:

```powershell
npm run bot
```

Create the bot with [@BotFather](https://t.me/BotFather), copy its token into
`TELEGRAM_BOT_TOKEN`, then send `/start` to the bot. It will show the API
Dashboard, Top up, Logs, and Redeem Code menu.

The bot creates user API keys automatically and stores accounts, keys, request
logs, and token totals in `data/users.json`. Requests made with a generated key
are tracked by the proxy. Keep this JSON file private because it contains API
credentials.

Top ups use Cashi.id. Set the Cashi API key and webhook secret, then configure
your Cashi webhook URL as:

```text
https://your-domain.example/webhooks/cashi
```

The webhook verifies `x-gateway-signature` with HMAC-SHA256 and credits a
pending order only after Cashi sends `PAYMENT_SETTLED` with status `SETTLED`.

## Test

```powershell
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/v1/models
```

## Notes / assumptions

- OpenAI-compatible authentication is supported. When `UPSTREAM_API_KEY` is set,
  the proxy sends `Bearer <UPSTREAM_API_KEY>` upstream for every request. This
  allows OpenAI SDK clients to use any local placeholder key.
- Mounted at `/v1` because the upstream's API surface lives under `/v1`; adjust
  `pathRewrite` in `server.js` if the upstream contract changes.
- Request logging is console-only (via `morgan`), not persisted to a file or external
  log service -- consistent with the "minimal first version" scope.
- No retries, rate limiting, log persistence, or request/response transformation --
  this is pass-through only, by design, per the "minimal first version" requirement.

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
The database path is pinned to `data/users.json`; writes are locked and atomic
so restarting the bot or API does not generate a new database or overwrite
existing keys and balances.

The API Dashboard lists every active key and its usage totals. Users can create
additional keys or revoke an existing key; revoked keys are rejected by the
proxy immediately. Dashboard actions include Logs, Model Price, and Top Up Saldo.
Use `/model` (or the Resync Models button) to fetch the latest model list from
the upstream `/v1/models` endpoint and refresh `data/models.json`.
Model IDs from Groq, Qwen, ChatGPT, Hy, DeepSeek, GLM, and Kimi are displayed
to clients without the upstream `1/` and `cx/`
prefixes; the proxy keeps an internal alias so those requests still reach the
correct upstream model.

The admin Telegram account is restricted to ID `6957236291`. It can open
`/admin`, enable or disable global free-model mode, and broadcast announcements.
The admin panel also supports fixed or custom balance adjustments: send `+50000`
to add Rp50.000 or `-10000` to deduct Rp10.000 from a selected user.
Admin Logs records the last 500 `/v1` requests, including method, path, status,
duration, model, and user ID.
Free mode still requires a valid user API key; it only skips balance deduction.

### Model access codes

Admin Panel -> **Kode Akses Model** creates unique, single-use codes
(`MDL-XXXXXX-XXXXXX`) that bind one or more models and a period. The admin picks
the models, then one of two period kinds:

- **Duration since redemption** (e.g. 7 days): access starts when the user
  redeems the code. The code can be redeemed until its redeem deadline
  (default 30 days after it was created, adjustable).
- **Fixed range** (start and end, WIB): access only runs inside that window,
  whenever the code is redeemed. Once the end has passed the code is expired.
  A code redeemed before the start waits for the start.

Users redeem the code with the same **Redeem Code** button or `/redeem <code>`
as balance codes. A code only adds access and never blocks anything: while it
is active, the user can use the code's models even when the admin has disabled
them (model or whole family) for everyone else, and `/v1/models` lists them for
that user. Every other model keeps working exactly as for any other user. To
make a model exclusive, disable it in **Disable Model** and hand out access
codes for it. Several active codes add up. When the period ends the extra access
ends by itself (it is worked out from the clock on every request). Prices,
balance, bonus tokens, BANSOS and rate limits are unchanged.

The admin list shows each code's status (unused, in use, waiting to start,
finished, expired, disabled, stopped). The admin can disable an unused code, or
stop a running one, which ends the user's extra access at once. Codes
live in `data/users.json` (`accessCodes`, plus `modelAccess` on the user). The
data layer refuses to create or disable codes for anyone other than
`ADMIN_TELEGRAM_ID` (default `6957236291`, set it on both hosts when they are split).

Top ups use Cashi.id. Set the Cashi API key and webhook secret, then configure
your Cashi webhook URL as:

```text
https://your-domain.example/webhooks/cashi
```

The webhook verifies `x-gateway-signature` with HMAC-SHA256 and credits a
pending order only after Cashi sends `PAYMENT_SETTLED` with status `SETTLED`.

Paid model prices include a default 25% markup, rounded to the nearest Rp50.
Change `MODEL_PRICE_MARKUP` in `.env` to adjust the profit markup. Free models
remain free.

## Test

```powershell
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/v1/models
```

## Notes / assumptions

- OpenAI-compatible authentication is supported. When `UPSTREAM_API_KEY` is set,
  the proxy sends `Bearer <UPSTREAM_API_KEY>` upstream for every request. This
  allows OpenAI SDK clients to use any local placeholder key.
- Client requests must use an active Telegram-generated `sk-user-...` key in
  `Authorization: Bearer <key>` (or `x-api-key: <key>`). OpenCode's custom
  provider should use `http://127.0.0.1:8080/v1` when running on this machine.
- Requests from users with a zero or missing balance are rejected with HTTP
  `402 Payment Required` until they complete a top up.
- Mounted at `/v1` because the upstream's API surface lives under `/v1`; adjust
  `pathRewrite` in `server.js` if the upstream contract changes.
- Request logging is console-only (via `morgan`), not persisted to a file or external
  log service -- consistent with the "minimal first version" scope.
- No retries, rate limiting, log persistence, or request/response transformation --
  this is pass-through only, by design, per the "minimal first version" requirement.

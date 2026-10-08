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
Dashboard, Kredit Token, Beli Paket Token, Logs, and Redeem Code menu.

The bot creates user API keys automatically and stores accounts, keys, request
logs, and token totals in `data/users.json`. Requests made with a generated key
are tracked by the proxy. Keep this JSON file private because it contains API
credentials.
The database path is pinned to `data/users.json`; writes are locked and atomic
so restarting the bot or API does not generate a new database or overwrite
existing keys and balances.

The API Dashboard lists every active key and its usage totals. Users can create
additional keys or revoke an existing key; revoked keys are rejected by the
proxy immediately. Dashboard actions include Kredit Token, Beli Paket Token,
Model & Multiplier, Logs and Usage Summary. The old per-1M Rupiah price list
(`/model`) is only linked from Model & Multiplier for users who still hold a
Rupiah balance. **Usage Summary** (also `/usage`) shows requests, tokens and
cost per model for today, the last 7 days (with a per-day breakdown) or the last
30 days, in WIB. It is kept in `data/usage-daily.json` (last 31 days) and counts
from the moment this feature was deployed.
Use `/model` (or the Resync Models button) to fetch the latest model list from
the upstream `/v1/models` endpoint and refresh `data/models.json`.
Model IDs from Groq, Qwen, ChatGPT, Hy, DeepSeek, GLM, and Kimi are displayed
to clients without the upstream `1/` and `cx/`
prefixes; the proxy keeps an internal alias so those requests still reach the
correct upstream model.

The admin Telegram account is restricted to ID `6957236291`. It can open
`/admin`, enable or disable global free-model mode, and broadcast announcements.
**Users & Top Up** lists users 10 per page (most recently active first) and
searches by Telegram ID, `@username` or name. Each user has a page with balance,
masked API keys, usage (total and last 7 days), active model access codes,
referral, open ticket and the last requests, plus fixed or custom balance
adjustments: send `+50000` to add Rp50.000 or `-10000` to deduct Rp10.000.
Announcements and polls are sent in the background at most 20 messages per
second (Telegram allows about 30), retrying when Telegram asks to slow down.
The admin's status message shows progress and then how many were delivered,
unreachable (blocked the bot / deleted account) or failed. A restart stops a
running broadcast.
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

Billing uses the token counts the upstream reports. For streaming
`chat/completions` requests the proxy adds `stream_options.include_usage`, so
the upstream sends a final usage chunk (clients also receive that standard
chunk with `"choices": []`; set `FORCE_STREAM_USAGE=false` if the upstream
rejects the field). Compressed responses are decompressed for reading, and
usage is read from OpenAI, Responses API and Anthropic streams. When a
successful generation still reports no tokens, they are estimated from the text
(about 4 characters per token) and the log entry is marked as an estimate.

Paid model prices include a default 25% markup, rounded to the nearest Rp50.
Change `MODEL_PRICE_MARKUP` in `.env` to adjust the profit markup. Free models
remain free.

## Kredit token

Pengguna membeli **kredit token** (tombol **🛒 Beli Paket Token** di menu, API Dashboard dan
layar Kredit Token, atau perintah `/topup`; saldo lewat `/kredit`). Tombol ini butuh Payments
dibuka (Admin Panel → Enable Payments). Top up saldo Rupiah lama mati secara default
(`billing legacy_topup on` untuk menyalakannya lagi); saldo Rupiah yang sudah ada tetap terpakai.
Kredit terpakai = (token input + token output yang ditagihkan) × multiplier model,
dihitung dengan fixed-point (4 desimal) dan dibulatkan ke atas satu kredit sekali di akhir.
Tidak ada minimum per request dan kredit tidak kedaluwarsa. 1 kredit = 1 token di model ×1;
token aktual = kredit ÷ multiplier. Multiplier adalah tarif jual toko, bukan harga resmi provider.

Paket default: 10 jt kredit Rp4.000, 25 jt Rp8.000, 50 jt Rp15.000, 100 jt Rp28.000.
Default paket dan multiplier ada di `credit-rules.js`; perubahan admin disimpan sebagai
override di `data/credit-config.json` (berversi, tercatat di audit).

File data (di samping `users.json`, saldo Rupiah lama tidak disentuh):

| File | Isi |
| --- | --- |
| `data/credits.json` | saldo kredit, reservasi berjalan, order kredit/unlimited, paket unlimited, riwayat singkat |
| `data/credits-ledger.jsonl` | ledger lengkap (append-only): `purchase`, `usage`, `refund`, `adjustment`, `unlimited_purchase` |
| `data/credit-config.json` | override admin + audit (dibuat saat perubahan pertama) |

### Siapa yang membayar sebuah request

Diputuskan sekali sebelum request diteruskan, berurutan:

1. **Free mode / BANSOS** aktif: gratis (perilaku lama).
2. **Paket unlimited** aktif yang mencakup model itu: tidak memotong kredit.
3. **Kredit token**: bila model punya tarif dan kredit tersedia > 0.
4. **Saldo Rupiah lama / bonus token referral** dengan harga per 1M lama (`billing legacy_rupiah on`).

Model tanpa tarif (`glm-5v-turbo`, `kimi-k3-1`, model baru dari upstream) dan alias yang belum
dipetakan (`claude`, `gemini-3.8-flash`, `gemini-3-flash-agent`, `gemini-pro-agent`) berstatus
**menunggu konfigurasi**: ditolak 403 `model_pending_configuration` untuk pembayaran kredit.
Tidak ada multiplier 0 (ditolak) dan tidak ada tebakan dari nama model.

### Reservasi, pemotongan, streaming

- Sebelum request: tarif di-snapshot (model, provider, routing, multiplier, versi config), lalu
  kredit direservasi atomik untuk estimasi input (panjang teks ÷4, +`input_buffer`%) dan batas
  output (`max_tokens`/`max_completion_tokens`/`max_output_tokens`, atau `output_default`).
  Bila saldo tidak cukup untuk batas output itu, batasnya diturunkan (header `X-Credit-Output-Limit`);
  bila tidak cukup untuk `output_min` token, request ditolak 402 `insufficient_credits`.
- Setelah respons: reservasi dipotong **sekali** dengan usage upstream memakai snapshot tadi,
  sisanya dilepas. Pemotongan tidak pernah melebihi kredit yang masih bebas, jadi saldo tidak
  pernah negatif; kekurangan (bila usage jauh di atas reservasi) dicatat sebagai `shortfall`.
- Usage dibaca dari OpenAI chat/completions, Responses API, DeepSeek, Anthropic (cache token
  dijumlahkan sekali), Gemini `usageMetadata`. Token reasoning dan cached token tidak dihitung
  dua kali. Tarif terpisah input/cache/output bisa diatur; defaultnya multiplier dasar.
- Streaming: proxy meminta `stream_options.include_usage` dan memakai usage akhir.

Kebijakan bila usage tidak ada:

| Kejadian | Ditagih |
| --- | --- |
| Respons sukses tanpa usage | estimasi dari teks (input + output), ditandai `estimated` |
| Stream terputus di tengah | usage yang sempat dilaporkan, minimal estimasi teks yang sudah keluar; ditandai `partial` + `estimated` |
| Upstream error (status ≥ 400) tanpa usage, upstream tidak menjawab | 0 (reservasi dilepas) |
| Klien menutup koneksi dan upstream tidak pernah menjawab | estimasi input (prompt sudah terkirim), `estimated`. Bila upstream tetap menjawab, usage aslinya yang dipakai |
| Reservasi yatim (server mati/restart, atau lebih tua dari `ttl`) | estimasi input (`orphan charge`) atau dilepas (`batas orphan release`) |

### Pembayaran

Order kredit/unlimited dibuat di server lebih dulu (harga dan isi dari konfigurasi server), baru
Cashi diminta QR dengan jumlah itu. Kredit ditambahkan hanya bila webhook Cashi yang ditandatangani
(atau Refresh status yang mengecek Cashi) menyatakan `SETTLED` untuk order itu dengan jumlah ≥ harga.
Webhook berulang tidak menambah kredit lagi. Bila jumlah tidak dikirim/kurang, order tetap pending;
admin bisa memeriksa lalu `order <id> konfirmasi`. Order top up Rupiah lama (`TG-...`) tetap seperti dulu
(kini jumlah yang dilaporkan lebih kecil dari order juga ditolak).

### Paket unlimited

Durasi 1/3/6/12/24 jam, harga awal kosong dan **tidak dijual** sampai admin menetapkan harga,
mengaktifkan durasi, mengisi daftar model, lalu `unlimited jual on`. Batas per user: request
bersamaan, request/menit, output maksimal. Model, batas dan harga disalin ke paket saat dibeli.
Membeli lagi saat aktif = paket baru mulai setelah paket sekarang berakhir.

### Perintah admin

Admin Panel → **Kredit & Paket** → **Ketik perintah** (boleh beberapa baris sekaligus). Semua
perintah diperiksa di server terhadap `ADMIN_TELEGRAM_ID` dan dicatat (Audit / ledger).

```text
paket kredit-10m 10000000 4000          paket kredit-10m off
tarif glm-5v-turbo 1.5                  tarif kimi-k3-1 pending
tarif glm-5.2 cache 0.5                 (tarif terpisah input | cache | output)
alias claude claude-sonnet-4-6          effort gemini-3.8-flash high gemini-3.8-flash-high
alias gemini-pro-agent gemini-3.1-pro-low
tool gemini-pro-agent 2000              (kredit per tool call provider)
route cbcn deepseek-v4-flash deepseek-v4.1-flash
route cbcn deepseek-v4-flash -          (hapus aturan routing)
batas output_default 8192               billing legacy_rupiah off
unlimited harga 1 5000                  unlimited 1 on
unlimited model tambah glm-5.1 kimi-k2.6
unlimited batas rpm 20                  unlimited jual on
kredit 123456789 +10000000 bonus        refund 123456789 25000 request gagal
order KR-123456789-1700000000000-ABC123 konfirmasi
```

**Routing DeepSeek**: `deepseek-v4-flash` dan `deepseek-v4-pro` adalah alias bergulir, `-0731`,
`-0813` dan `deepseek-v4.1-flash` checkpoint asli. Bila suatu provider (awalan route di
`data/models.json`, mis. `cbcn`) mengarahkan alias ke V4.1-Flash, catat dengan `route` untuk
provider itu saja: tarif ×1,5 dipakai hanya di sana. Provider lain tetap memakai tarif aslinya.

### Migrasi dan rollback

Migrasi tidak mengubah `users.json` dan tidak mengonversi Rupiah ke kredit.

```powershell
node scripts/migrate-credits.js          # dry run: hanya laporan
node scripts/migrate-credits.js --apply  # backup ke data/backups/pre-credits-<waktu>/, lalu buat data/credits.json
```

Upload ke host: `credit-rules.js`, `credit-config.js`, `credit-store.js`, `server.js`, `usage-db.js`,
`data-client.js`, `telegram-bot.js`, `scripts/migrate-credits.js`. Pada hosting terpisah, host bot
butuh `credit-rules.js` (dan semua file kredit bila bot memakai data lokal). Jalankan migrasi di host `server.js`, lalu restart `server.js`
dan `telegram-bot.js`. Kredit baru aktif bila Free Mode OFF dan Payments OPEN.

Rollback: hentikan kedua service, kembalikan file kode versi sebelumnya (git), restart. Saldo Rupiah
tetap utuh karena tidak pernah diubah. Simpan `data/credits.json`, `data/credits-ledger.jsonl` dan
`data/credit-config.json` (jangan dihapus): kredit yang sudah dibeli tercatat di sana dan bisa
dipulihkan dengan memasang kode baru lagi. Isi `data/backups/pre-credits-*` adalah salinan sebelum migrasi.

Tes otomatis (mock upstream dan mock Cashi, folder data sementara): `npm test`.

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

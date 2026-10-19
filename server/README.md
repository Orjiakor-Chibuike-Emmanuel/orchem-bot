# Orchem Bot — Server Edition (v15)

This is the always-on version of Orchem Bot. It runs the exact same
trading logic as the browser version (`index-v15.html`) — boundary-candle
breakout detection, 30min confirmation with strict invalidation, the
volatility-scaled exhaustion filter, tight stop-loss, $35-risk position
sizing, leverage suggestion — but as a Node service instead of a page in
a browser tab.

**Why this exists:** the browser version only scans and alerts while a
tab stays open and awake on some device. A phone locking, a backgrounded
tab getting killed, or a closed laptop silently stops everything. This
server version runs on its own, independent of any device, and keeps
scanning and sending Telegram alerts as long as the Render service is up.

## What changed vs. the browser version

- **Telegram token moved server-side.** It was previously hardcoded in
  plaintext in the HTML, visible to anyone who viewed page source on
  GitHub Pages. It's now an environment variable, never shipped to a
  client.
- **Telegram sends via POST+JSON instead of GET.** The GET workaround in
  v15 existed to dodge a CORS preflight that only applies to *browser*
  callers. A server calling Telegram's API has no CORS restriction at
  all, so it uses the normal documented method — also avoids putting the
  bot token in a URL that proxies/logs might record.
- **State persists to disk (`data/*.json`)** instead of `localStorage`.
- **The confirmation loop runs independently of the scan**, and more
  often (every 5 min by default vs. the scan's 1 hour) — see
  `CONFIRM_INTERVAL_MS` below. There's no reason to wait a full hour to
  notice a 30min candle closed, once this isn't constrained by a
  browser tab's battery/data use.
- **The frontend is now a read-only dashboard** that polls the server's
  API. All trading logic — the scan, the confirmation loop, Telegram
  sending — runs on the server whether or not anyone has the dashboard
  open.

## Bybit Demo Trading auto-execution (optional)

Set `BYBIT_API_KEY`, `BYBIT_API_SECRET`, and `BYBIT_AUTO_TRADE=true` and the
bot will, on every confirmed entry, automatically open the matching market
position on **Bybit's Demo Trading account** — a real feature of Bybit's
API, completely separate from their live account and live API domain. A
key generated under Demo Trading physically cannot place a live order,
even if something here were misconfigured.

What happens on a confirmed entry when this is on:
- Opens a `Market` order on Bybit's linear USDT-perpetual market for the
  same symbol/direction the signal fired on.
- Attaches the stop-loss and take-profit from the signal directly on the
  order (Bybit's "Full" TP/SL mode) — never opens a position with no stop.
- Position size and leverage come from the same `MAX_RISK_USD`/
  `MARGIN_PER_TRADE_USD` math as the Telegram alert, rounded to whatever
  quantity step Bybit requires for that symbol.
- The Telegram alert always still goes out, with a line added reporting
  what Bybit did (placed / skipped / failed and why) — this never replaces
  the alert, only adds to it.

This stays OFF by default (`BYBIT_AUTO_TRADE` unset or anything but the
literal string `"true"`), even with API keys present — it's an explicit
opt-in, not automatic.

**What I could not verify from here:** same sandbox network restriction as
Binance/Telegram below — I built this against Bybit's documented V5 API
request/response shapes but could not place a real demo order to confirm
end-to-end. Watch the Telegram alert text (or Render logs for `[bybit]`
lines) after the first confirmed signal to confirm it actually placed.

## Before you deploy: what I could NOT test from here

This was built and syntax-checked in a sandboxed environment whose
network access is restricted to package registries and GitHub — it
cannot reach `api.binance.com` or `api.telegram.org` at all (same
limitation that applied to verifying the Telegram fix in v15). So:

- All the pure trading logic (boundary detection, sizing, filters) was
  tested directly with synthetic candle data and confirmed correct.
- The Binance and Telegram network calls are **unverified from here** —
  they're ported faithfully from the tested v13/v14/v15 logic and use
  documented, standard request shapes, but you should watch the Render
  logs after first deploy to confirm candles are actually being fetched
  and a test alert actually arrives.

## Deploying to Render

1. **Push this folder to a GitHub repo** (a new one, or a new folder in
   an existing one — just make sure `node_modules/` and `.env` are not
   committed; `.gitignore` already excludes them).

2. **On Render:** New → Web Service → connect the repo.
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** the free tier works but *spins down after 15
     minutes of no inbound HTTP traffic* — which would defeat the whole
     point of "always on". Either:
     (a) upgrade to a paid instance (starts at a few dollars/month, stays
     running continuously), or
     (b) stay on free and use an external uptime pinger (e.g.
     UptimeRobot, cron-job.org) to hit `/api/health` every 10 minutes to
     keep it awake. (a) is the more honest fix for a bot trading real
     money — (b) is a workaround with a gap during the restart it causes.

3. **Set environment variables** in the Render dashboard (Settings →
   Environment) — copy the names from `.env.example`:
   - `TG_TOKEN` — your bot token
   - `TG_RECIPIENTS` — comma-separated chat IDs
   - `MAX_RISK_USD`, `MARGIN_PER_TRADE_USD`, `MAX_SENSIBLE_LEVERAGE`
   - `SCAN_INTERVAL_MS`, `CONFIRM_INTERVAL_MS` (optional, defaults shown
     in `.env.example`)

4. **Deploy.** Render will build and start the service. Check the logs
   for `Orchem Bot server listening on port ...` and the first scan
   cycle.

5. **Open the dashboard** at your Render service's URL
   (`https://<your-service>.onrender.com`) to watch channels live.

## A note on data durability

Render's filesystem is **not persistent across restarts/redeploys**
unless you attach a [Render Disk](https://render.com/docs/disks) (a
small paid add-on). Without one:
- Today's watchlist/alert state resets on restart — worst case, it just
  re-scans and rebuilds, no harm done.
- The trade log (`data/trade-log.json`) resets too — this is a real
  loss of history on every redeploy/restart. Until you attach a disk,
  treat the Telegram messages themselves as your durable trade record,
  not the in-app logbook. Attaching a disk and pointing `DATA_DIR` at it
  is a quick follow-up once you confirm everything else works.

## Local testing

```
cp .env.example .env   # fill in your real TG_TOKEN
npm install
npm start
```

Then open `http://localhost:3000`.

# Perpl Volume Bot (SOL)

A volume-farming bot for [Perpl](https://app.perpl.xyz) (perp DEX on Monad), built to
maximize points-weighted trading volume at the lowest possible cost. Developed and
tuned live on mainnet, currently trading BTC (`MARKET_ID=1`).

## The model (why it's cheap)

Perpl charges fees **only on the opening leg** of a position (0.9bps maker / 6.9bps
taker at Tier 1). Closing is always free, maker or taker. The bot exploits that
asymmetry:

- **Opens are maker-only.** It posts a post-only order at the touch and "chases"
  patiently (re-posting only when price moves away, so it keeps its queue position;
  up to 10 attempts x 8s). If it can't fill as maker it just skips the cycle - it
  NEVER pays taker fees to open. If one side won't fill (trending market), it flips
  long/short, because the opposite side fills easily in a trend.
- **Closes are instant market orders.** Free either way, so the only cost is the
  half-spread (varies per market - ~0.1bps was measured on SOL, see below), and the
  position's market risk ends within seconds.
- **Trend guard.** It refuses to open when mid price moved more than 3.5bps in the
  last 10s. Maker fills in a trending market are adversely selected (you get filled
  precisely when price runs through you) - waiting for chop cut measured PnL drag by
  ~60%.
- Cycles alternate long/short, so net directional exposure stays ~flat.

## Measured results (historical benchmark: mainnet SOL, $100 notional/leg, 10x)

These numbers are from an earlier SOL run and are kept here as a reference point for
the model's mechanics - they have NOT been re-measured on BTC (the market this bot
currently trades) and will differ somewhat with BTC's own spread/fee/liquidity
profile. From a continuous 1-hour run on SOL (185 positions, audited against exchange
fill records):

| Metric | Value |
|---|---|
| Volume pace | ~$34,000/hour |
| Fees | 0.45bps ($45 per $1M volume) |
| All-in burn (fees + PnL drag) | **~0.56bps = ~$56 per $1M volume** |
| Maker ratio on opens | 100% |

Rule of thumb: ~$820k volume per 24h of runtime, costing ~$46/day all-in.

## Setup

Nothing secret is stored in this repo - your API key, API secret, and wallet key
only ever live in your own local `.env` file, which is gitignored (never gets
committed or shared when you push/pull this repo). Same for `logs/` (trade
history, the Excel reports) - that's all local-only too.

1. Install [Node.js](https://nodejs.org) LTS.
2. `npm install`
3. `cp .env.example .env` - this is your personal config file. You'll fill in the
   blanks below; nobody else sees it.
4. Get a wallet with some funds on Monad:
   - Deposit AUSD on [app.perpl.xyz](https://app.perpl.xyz) with your wallet (min 10
     AUSD; you also need a little MON for gas). This deposit is what the bot trades
     with, and fees come out of it.
5. Get your one-time enrollment key ready:
   - Open `.env` and paste your wallet's private key into `WALLET_PRIVATE_KEY`.
   - This is only used once, locally, to register an API key - it is never sent
     anywhere except signing that one request, and you'll delete it in step 7.
6. Run the enrollment script - this creates an API key for you automatically:
   ```
   npm run enroll-key
   ```
   It prints `PERPL_API_KEY` and `PERPL_API_KEY_SECRET` - paste both into `.env`.
   (You can also create a key manually at https://app.perpl.xyz/apikeys, scope
   `trade`, if you prefer. Either way: Perpl API keys can NEVER withdraw funds,
   regardless of scope - the worst a leaked key can do is trade with your deposit.)
7. **Delete the value of `WALLET_PRIVATE_KEY` from `.env` now** - you don't need it
   again unless you want to enroll a new key later. Leaving it in isn't dangerous
   (it never leaves your machine), but there's no reason to keep it lying around.
8. Set `PERPL_NETWORK=mainnet` in `.env` when you're ready for real trading (leave
   it as `testnet` to try the bot with no real money first).
9. Sanity check (read-only, no orders placed): `npx tsx scripts/check-connection.ts`
10. Start the bot: `npm run bot`

That's it - steps 3-9 are the only ones each new person running this needs to
repeat; everything else in the repo works as-is.

## Running

```
npm run bot
```

Key `.env` knobs:

| Var | Meaning |
|---|---|
| `MARKET_ID` | 1 = BTC mainnet (SOL=31, MON=10, ETH=20, HYPE=40, ZEC=50). Prefer boosted-points markets with deep OI. |
| `NOTIONAL_USD` | Size per leg. Validated at 25-100; margin used per cycle = notional/leverage. |
| `LEVERAGE` | Auto-clamped to each market's real max (initial_margin/100). |
| `TARGET_VOLUME_USD` | Stop after this much true volume (0 = no cap). |
| `MAX_RUNTIME_MIN` | Stop after N minutes (0 = no limit). |
| `TREND_GUARD_MAX_DRIFT_BPS` | Skip opens when 10s mid drift exceeds this (0 = off). |
| `COST_LADDER_CYCLES` | Cycles the cost ladder averages over (0 = off). See below. |

Every cycle prints a `[totals]` line with live volume, fees, and $-per-1M burn.

### Cost ladder (size follows cost)

Cost per $1M swings a lot - a rolling median near $63 but a p95 of $94 - and a fixed
notional does full-size volume straight through the expensive stretches. The ladder
measures all-in cost (fees - PnL) per $1M over the last `COST_LADDER_CYCLES` cycles
and maps it to notional on a **continuous linear scale** (not discrete steps):

| measured cost | notional |
|---|---|
| <= `COST_LADDER_TIER1_USD_PER_M` | `NOTIONAL_USD` (full) |
| >= `COST_LADDER_TIER2_USD_PER_M` | `COST_LADDER_NOTIONAL_FLOOR` |
| between | straight line from full down to the floor |

A small cost move produces a small size move - there's no fixed "mid" size any more
(an earlier version stepped full -> mid -> floor; replaced 2026-09-08 so a small cost
change never produces a jump). Since notional now moves every cycle, logging/ntfy is
throttled separately by `COST_LADDER_NOTIFY_STEP_USD` - only announced once it's moved
that many dollars since the last announcement (default $75, chosen to match the old
step function's ~1-per-29-cycles cadence).

Replayed over the 25,184 cycles in `logs/cycles.jsonl`: 58% of the volume kept for 51%
less burn, $64.01 -> $53.69 per $1M (at the current `COST_LADDER_CYCLES=70`, ~1h at the
observed pace - raised from an initial 12 (~10 min) on 2026-09-08 to cut flapping during
a live WebSocket-instability episode). Re-check against your own logs with
`npx tsx scripts/replay-ladder.ts`.

Two things to understand before turning it on:

- **It doesn't make trades cheaper.** Fees and spread are percentages, so a smaller
  clip costs the same per dollar. The gain is *selection* - more volume when cheap,
  less when expensive. The volume you give up costs ~$80/$1M, so if points earned on
  it are worth more than that, the ladder loses you money.
- **The floor keeps trading, deliberately.** It never stops: the metric is a ratio, so
  it stays valid at floor size, and a stopped bot would freeze its own input and never
  discover that conditions had improved. The floor is raised at runtime to the market's
  `min_posting_amount` when that is larger, since an order below the exchange minimum
  can never fill - `openMakerThenTaker` throws rather than let a chase spin on it.

## Deploying to a VPS (Vultr)

The bot is a single Node process doing WebSocket I/O - the smallest instance is
plenty. What actually matters is that it stays up unattended and that cron can
stop it safely, which is what the steps below set up.

**1. Create the instance.** Ubuntu 24.04 LTS, Regular Cloud Compute, smallest
plan (1 vCPU / 1GB). Add your SSH key at creation time so password auth is never
needed. Region: pick one with low latency to Perpl - a slow link costs maker
fills (the chase gives up after `MAKER_TIMEOUT_MS`), so it shows up as burn, not
as errors. Measure before committing:
`curl -o /dev/null -s -w '%{time_connect}\n' https://app.perpl.xyz/api/`

**2. Harden and set the clock to UTC.** As root:

```
adduser --disabled-password --gecos "" perpl && usermod -aG sudo perpl
rsync --archive --chown=perpl:perpl ~/.ssh /home/perpl/
ufw allow OpenSSH && ufw --force enable
timedatectl set-timezone UTC
apt update && apt upgrade -y
```

Then disable `PermitRootLogin` and `PasswordAuthentication` in
`/etc/ssh/sshd_config` and `systemctl restart ssh`. UTC isn't strictly required -
`schedule-window.sh` converts UTC to box-local time either way - but it makes
cron entries, `pm2 logs`, and the bot's own UTC timestamps all line up.

**3. Install Node system-wide (not nvm).** Cron runs with a near-empty PATH and
no nvm; a system install at `/usr/bin/node` avoids that whole class of failure:

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**4. Clone the repo.** For a private repo, generate a key on the server and add
the public half as a read-only deploy key on GitHub:

```
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub    # -> GitHub repo > Settings > Deploy keys
git clone git@github.com:<you>/perpl.git ~/perpl
```

**5. `npm install` - with devDependencies.** Not `--omit=dev` / `--production`:
`ecosystem.config.cjs` runs `./node_modules/.bin/tsx`, and `tsx` is a
devDependency. Omitting it makes pm2 fail to start with a confusing "script not
found".

**6. Copy `.env` from your machine.** It's gitignored, so it never arrives with
the clone:

```
scp .env perpl@<ip>:~/perpl/.env && ssh perpl@<ip> "chmod 600 ~/perpl/.env"
```

Leave `WALLET_PRIVATE_KEY` **blank** - enrollment already happened, and the
server never needs it. That means a compromised server can't touch your wallet,
and a Perpl API key can never withdraw regardless of scope: the worst case is
unauthorised trading with the deposit. Set `NTFY_TOPIC` so `stop-window.sh` can
alert you when a stop fails.

**7. Verify before trading anything** (both read-only, place no orders):

```
npx tsx scripts/check-connection.ts
npx tsx scripts/check-live-state.ts
```

**8. Start under pm2 and survive reboots:**

```
sudo npm install -g pm2
cd ~/perpl && npm run pm2:start
pm2 save
pm2 startup systemd     # prints a sudo command - run what it prints
```

**9. Make the cron log writable.** `schedule-window.sh` logs to
`/var/log/perpl-cron.log`, which a non-root user cannot create - without this,
cron output is silently discarded and a failed window leaves no trace:

```
sudo touch /var/log/perpl-cron.log && sudo chown perpl:perpl /var/log/perpl-cron.log
systemctl status cron    # confirm cron is actually running
```

**10. Schedule the window** (see the next section), then confirm with
`./scripts/schedule-window.sh --show` and `crontab -l`.

**Never run the bot on two machines against the same account.** Two instances
share a per-account request-id sequence and corrupt each other's orders - the
same hazard as a zombie process. Stop the local one before starting the VPS one.

## Scheduled run windows (VPS, UTC)

`scripts/schedule-window.sh` writes two cron entries: one that starts the bot, one
that stops it. Times are UTC; run it on the Linux VPS (needs GNU `date -d`).

```
./scripts/schedule-window.sh "2026-08-22 08:00" "2026-08-23 23:59"
./scripts/schedule-window.sh --show     # what is scheduled
./scripts/schedule-window.sh --clear    # cancel a pending window
```

The stop entry runs `scripts/stop-window.sh`, which is a *safe* stop, not just
`pm2 stop`: it stops the app, waits until the process is genuinely down (the bot
gets up to `kill_timeout` to finish its in-flight cycle), then runs
`scripts/flatten.ts` - cancel every working order, close every open position, on
every market - and re-checks until the account is verified flat, retrying up to 3
times. It exits non-zero and pushes an ntfy alert if it cannot get to flat, so a
window never ends with risk left on the exchange.

It will not flatten while the bot is still alive - a flatten racing a live bot
corrupts the per-account request-id sequence they share. So: an app name pm2 does
not recognise is a hard error (exit 2, ntfy) instead of a shrugged-off "probably
already stopped"; liveness is judged by pm2's own pid plus a cwd-scoped process
scan, not a command-line pattern; and a process that still will not exit 180s
after the stop signal is SIGKILLed, then flattened. The window's cron entries delete
themselves after the stop so the window doesn't repeat.

## Operational notes (learned the hard way)

- **Windows: check for zombie processes before every run** - Ctrl+C doesn't reliably
  kill the npm->tsx tree, and a hidden second instance will trade on your account:
  `Get-Process node` (should error/return nothing), kill anything found.
- **If the bot stops with a position open**: `npx tsx scripts/flatten.ts` cancels every
  working order and closes every open position, on all markets, then re-checks and
  only exits 0 once the account is verified flat (ntfy alert + exit 1 if not).
  `scripts/close-now.ts` is the narrower version (position on `MARKET_ID` only).
  Check state anytime with `npx tsx scripts/check-live-state.ts`.
- **Never stop the bot with `pm2 stop` alone.** It signals, waits `kill_timeout`, then
  SIGKILLs - a cycle stuck chasing a maker fill (or a fill landing during the kill) can
  leave a resting order or an open position behind. Use `./scripts/stop-window.sh`,
  which does `pm2 stop` -> waits for the process to be really down -> flattens ->
  verifies. Scheduled windows call it automatically at their stop time.
- **Check the pm2 app name before overriding it.** `stop-window.sh` defaults to
  `perpl-bot`; `PERPL_PM2_APP=<name>` only helps if `<name>` is what `pm2 list` shows.
  Passing a name pm2 does not have used to log "app may already be stopped" and then
  flatten against a fully live bot - it now aborts loudly instead, but `pm2 list` is
  still the thing to check first.
- **Audit any run against exchange records** (ground truth, not the bot's own logs):
  `npx tsx scripts/audit-run.ts <runStartEpochMs>` - prints true volume, fees, PnL,
  all-in burn, maker ratio, and volume/hour.
- Orders on Perpl live at most `order_ttl_blocks` (varies per market, ~8s was
  measured on SOL); the bot handles this, but it's why you see constant re-posting
  in the logs.
- Perpl's docs warn wash-trading detection can cut points multipliers. This bot runs
  a single wallet with alternating sides, but it IS metronomic - for long 24/7
  operation consider varying notional/timing, and don't run mirrored wallets.
- The burn is real: ~$56 per $1M volume comes out of your deposit. Size your runway
  accordingly.

## Repo map

- `src/bot.ts` - main cycle loop (open -> confirm -> close -> log)
- `src/orderEngine.ts` - maker-chase open, instant close, watchdog force-close
- `src/tradingClient.ts` - authenticated trading WS (auth, sequence tracking, rq
  idempotency, position cache)
- `src/marketDataClient.ts` - public WS order book + mid-drift history
- `src/auth.ts` / `src/restClient.ts` - Ed25519 request signing, REST history
- `scripts/` - connection check, live-state check, emergency close, run audit

## Changes vs the original (July 2026)

- **Supervisor / auto-recovery**: WS drops or uncertain state no longer stop the bot
  permanently - it tears the session down, reconnects with backoff (15s -> 5m),
  force-closes any leftover position before trading again, and carries totals across
  restarts. Gives up only after 20 consecutive failures with zero completed cycles.
- **Feed staleness watchdog**: both WS clients terminate and reconnect if the feed
  goes silent for 15s (half-open sockets froze the order book for 45min once -
  the bot posted at stale prices and never filled).
- **Chain-head extrapolation**: order expiry blocks are stamped from an extrapolated
  head (observed ms/block from heartbeats), not the last heartbeat, reducing
  "Invalid Expiry Time" (ExceedsLastExecutionBlock) rejects. ORDER_EXPIRY_BLOCKS=18
  recommended (max 20, keep headroom).
- **PERPL_ACCOUNT_ID env var**: pin the bot to one account id. REQUIRED if you run
  several bots on one wallet - request ids are a per-ACCOUNT sequence, so two
  processes must never share an account (they will corrupt each other's orders).
- **start-bot.ps1 / stop-bot.ps1**: start refuses to double-start; stop kills the
  process tree AND closes any stranded position. On Windows, closing the terminal
  window is NOT a reliable stop - use stop-bot.ps1.

# Perpl Volume Bot (BTC)

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

Every cycle prints a `[totals]` line with live volume, fees, and $-per-1M burn.

## Operational notes (learned the hard way)

- **Windows: check for zombie processes before every run** - Ctrl+C doesn't reliably
  kill the npm->tsx tree, and a hidden second instance will trade on your account:
  `Get-Process node` (should error/return nothing), kill anything found.
- **If the bot stops with a position open**: `npx tsx scripts/close-now.ts` closes it
  (reduce-only IOC). Check state anytime with `npx tsx scripts/check-live-state.ts`.
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

import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { getContext } from "./restClient.js";
import { MarketDataClient } from "./marketDataClient.js";
import { TradingClient } from "./tradingClient.js";
import {
  armHardTimeoutForceClose,
  closeMakerThenTaker,
  fromScaled,
  openMakerThenTaker,
} from "./orderEngine.js";
import { logEvent } from "./eventLog.js";
import { MetricsTracker, cycleAllInCostUsd, costPerMillionUsd } from "./metrics.js";
import { OrderFlags, OrderType, type Account, type Position, type Wallet } from "./types.js";
import { logCloseToXlsx, logPeriodSnapshotToXlsx } from "./xlsxLog.js";
import { sendNtfyMessage } from "./ntfyNotifier.js";

// Two cadences: a frequent pulse (summary) and the slower full report that also
// writes the xlsx snapshot row.
const SUMMARY_INTERVAL_MS = config.summaryIntervalHours * 60 * 60 * 1000;
const REPORT_INTERVAL_MS = config.reportIntervalHours * 60 * 60 * 1000;

/** $12,345,678 -> "$12.35M". Volumes run to millions, so raw dollars are unreadable at a glance. */
function fmtMillions(usd: number): string {
  return `$${(usd / 1e6).toFixed(2)}M`;
}

function formatPeriodSummaryMessage(
  shared: SharedState,
  periodStartMs: number,
  periodEndMs: number,
  periodStartVolumeUsd: number
): string {
  const durationMs = periodEndMs - shared.runStartMs;
  const netCosts = shared.totalFeesUsd - shared.totalPnlUsd;
  const costsPerMillion = shared.totalVolumeUsd > 0 ? (netCosts / shared.totalVolumeUsd) * 1e6 : 0;
  const volumePerHour = durationMs > 0 ? shared.totalVolumeUsd / (durationMs / 3_600_000) : 0;
  // Volume since the last snapshot, so each push shows the period on its own
  // rather than only an ever-growing cumulative number.
  const periodVolume = shared.totalVolumeUsd - periodStartVolumeUsd;
  const periodHours = (periodEndMs - periodStartMs) / 3_600_000;
  const periodVolumePerHour = periodHours > 0 ? periodVolume / periodHours : 0;
  return (
    `Period: ${new Date(periodStartMs).toISOString()} -> ${new Date(periodEndMs).toISOString()}\n` +
    `Run duration so far: ${(durationMs / 3_600_000).toFixed(1)}h\n` +
    // The cost ladder varies size at runtime (see ladderNotionalUsd) - reporting
    // config.notionalUsd here would show the configured max, not what's actually
    // trading right now, which is exactly what a "why is cost what it is" push
    // needs to show.
    `Notional: $${shared.currentNotionalUsd.toFixed(2)}/leg (max $${config.notionalUsd}) at ${config.leverage}x\n` +
    `Deposit: $${shared.currentBalanceUsd?.toFixed(2) ?? "n/a"}\n` +
    `This period: ${fmtMillions(periodVolume)} vol | ${fmtMillions(periodVolumePerHour)}/h\n` +
    `Volume: ${fmtMillions(shared.totalVolumeUsd)}\n` +
    `Fees: $${shared.totalFeesUsd.toFixed(2)} | PnL: $${shared.totalPnlUsd.toFixed(2)} | Net cost: $${netCosts.toFixed(2)}\n` +
    `Cost: $${costsPerMillion.toFixed(0)} per $1M volume\n` +
    `Volume/hour: ${fmtMillions(volumePerHour)}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fixed config.cycleRestMs, unless CYCLE_REST_MIN_MS/MAX_MS are both set, in which case randomize within that range. */
function cycleRestDelayMs(): number {
  const { cycleRestMinMs: lo, cycleRestMaxMs: hi } = config;
  if (lo != null && hi != null) return lo + Math.random() * (hi - lo);
  return config.cycleRestMs;
}

function waitForEvent<T>(emitter: EventEmitter, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (arg: T) => {
      clearTimeout(timer);
      resolve(arg);
    });
  });
}

/**
 * Waits for an open position on this market (regardless of which order created it -
 * a position's `oid` field has been observed as 0/unreliable right after a fill, so
 * matching by oid is fragile; matching by "any open position on the market we just
 * traded" is safe since the bot always closes before opening the opposite side).
 *
 * Primarily event-driven: reacts the instant TradingClient's "positions" event
 * fires (as soon as the real PositionsUpdate arrives over the WS), instead of
 * discovering it up to pollIntervalMs late on a fixed timer. The poll is kept
 * as a safety-net fallback only (e.g. in case the position was already in the
 * cache from a message that arrived just before this function was called).
 */
function waitForOpenedPosition(
  trading: TradingClient,
  marketId: number,
  timeoutMs: number,
  pollIntervalMs = 1000
): Promise<Position | undefined> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    const tryResolve = (): boolean => {
      const found = trading.findOpenPositionForMarket(marketId);
      if (found) {
        cleanup();
        resolve(found);
        return true;
      }
      return false;
    };

    const onPositions = () => {
      tryResolve();
    };
    trading.on("positions", onPositions);

    function cleanup() {
      settled = true;
      trading.off("positions", onPositions);
    }

    const check = () => {
      if (settled) return;
      if (tryResolve()) return;
      if (Date.now() >= deadline) {
        cleanup();
        resolve(undefined);
        return;
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

/**
 * Event-driven counterpart to waitForOpenedPosition: resolves true the moment the
 * position cache says nothing is open on the market (reacting to "positions"
 * events as they arrive), false on timeout. Replaces a fixed post-close sleep -
 * PositionsUpdate typically lands within a few hundred ms of the IOC fill, so
 * waiting a hardcoded 1s per cycle was pure dead time (~5-8% of cycle length).
 */
function waitForPositionGone(
  trading: TradingClient,
  marketId: number,
  timeoutMs: number,
  pollIntervalMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    const tryResolve = (): boolean => {
      if (!trading.findOpenPositionForMarket(marketId)) {
        cleanup();
        resolve(true);
        return true;
      }
      return false;
    };

    const onPositions = () => {
      tryResolve();
    };
    trading.on("positions", onPositions);

    function cleanup() {
      settled = true;
      trading.off("positions", onPositions);
    }

    const check = () => {
      if (settled) return;
      if (tryResolve()) return;
      if (Date.now() >= deadline) {
        cleanup();
        resolve(false);
        return;
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

/**
 * Closes whatever is open on the market via IOC market order (reduce-only, tied to
 * the position id) - same approach as scripts/close-now.ts. Used at session start
 * so a position left behind by a crashed/disconnected session is flattened before
 * any new orders go out. Throws if the position survives all attempts.
 */
async function closeLeftoverPosition(trading: TradingClient, marketId: number): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const open = trading.findOpenPositionForMarket(marketId);
    if (!open) {
      if (attempt > 1) console.log("[recovery] leftover position closed, resuming");
      return;
    }
    const accountId = trading.getAccountId();
    if (accountId == null) throw new Error("no account id while closing leftover position");
    console.warn(
      `[recovery] leftover open position pid=${open.pid} side=${open.sd === 1 ? "long" : "short"} ` +
        `size=${open.s} - closing before trading resumes (attempt ${attempt}/5)`
    );
    try {
      await trading.placeOrder({
        mkt: marketId,
        acc: accountId,
        t: open.sd === 1 ? OrderType.CloseLong : OrderType.CloseShort,
        p: 0, // market
        s: open.s,
        lp: open.pid,
        ms: config.maxTakerSlippageBps * 4, // wide band - safety exit, not cost-optimized
        fl: OrderFlags.ImmediateOrCancel,
        lv: 0,
        lb: trading.getCurrentBlock() + 15,
      });
    } catch (err) {
      console.warn(`[recovery] close attempt ${attempt} got no status (${(err as Error).message}) - re-checking`);
    }
    await sleep(2000);
  }
  if (trading.findOpenPositionForMarket(marketId)) {
    throw new Error("could not close leftover position after 5 attempts");
  }
}

/** State that must survive session restarts (totals, cycle counter, side alternation). */
interface SharedState {
  cycleId: number;
  side: "long" | "short";
  totalVolumeUsd: number;
  totalFeesUsd: number;
  // Sum of each closed position's realized dpnl. This is price movement only -
  // it does NOT net fees (verified against deposit deltas), which is why the
  // all-in burn is totalFeesUsd - totalPnlUsd rather than just -totalPnlUsd.
  totalPnlUsd: number;
  // Dedup guard for the fill stream. Fills are replayed when a new session
  // subscribes, and `shared` outlives sessions, so without this every reconnect
  // re-counts the same fills into volume/fees. Measured on a 7-day run: 7,791
  // ws_closed events inflated reported volume to $26.5M against an exchange
  // all-time total of $15.4M (~2.8x). Fills carry no id, but `at` is the
  // on-chain (block, tx, log) coordinate, which is unique per fill.
  seenFillKeys: Set<string>;
  runStartMs: number;
  // Start of the current summary window (see SUMMARY_INTERVAL_MS below) -
  // survives restarts same as the totals, so a mid-window restart doesn't reset
  // the clock and produce a short extra row.
  periodStartMs: number;
  // Cumulative volume as of periodStartMs, so a snapshot can report the period's
  // own volume rather than only the run-long cumulative figure.
  periodStartVolumeUsd: number;
  // Same pair for the slower report window (REPORT_INTERVAL_MS), tracked
  // separately so the two cadences don't reset each other.
  reportStartMs: number;
  reportStartVolumeUsd: number;
  stopRequested: boolean;
  // Notional the cost ladder has chosen for the next open. Lives here rather than
  // on the session (or as a config mutation) so a session restart doesn't silently
  // snap size back to full - sessions died 172 times across the 3 weeks of logs.
  currentNotionalUsd: number;
  // Ring buffer of the last costLadderCycles cycles, feeding the ladder's cost/$1M.
  // On `shared` for the same reason: a session-scoped history would be empty after
  // every reconnect, and an empty history means the floor (see ladderNotionalUsd).
  recentCycles: Array<{ costUsd: number; volumeUsd: number }>;
  // Set once the ladder's cost/$1M goes from "not enough data" to a real number for
  // the first time this process lifetime - gates the one-time ntfy push announcing
  // the starting reading, so it fires once per start/restart, not once per cycle.
  costLadderFirstReadingSent: boolean;
  // AUSD deposit balance, tracked from wallet/account push updates for the xlsx log.
  // initialBalanceUsd is captured once (first balance seen) and never overwritten.
  initialBalanceUsd?: number;
  currentBalanceUsd?: number;
}

/**
 * Notional for the next open, from the all-in cost per $1M of recent cycles.
 * Cheap conditions get full size, expensive conditions progressively less.
 *
 * A null reading ("not enough cycles to judge yet") maps to the FLOOR, not full -
 * every cold start and every session restart (172 of them across 3 weeks of
 * history) starts with zero evidence conditions are cheap, so it starts small and
 * has to earn its way up to full size once a real window of low-cost cycles backs
 * it, rather than assuming it's safe by default.
 */
function ladderNotionalUsd(costPerMillion: number | null, floorUsd: number): number {
  if (costPerMillion == null) return Math.min(floorUsd, config.notionalUsd);
  if (costPerMillion <= config.costLadderTier1UsdPerM) return config.notionalUsd;
  // Every rung is clamped to notionalUsd so the ladder can only ever reduce size.
  if (costPerMillion <= config.costLadderTier2UsdPerM) {
    return Math.min(config.costLadderNotionalMid, config.notionalUsd);
  }
  return Math.min(floorUsd, config.notionalUsd);
}

/**
 * One trading session: connect, flatten leftovers, run cycles until a clean stop
 * (target volume / max runtime / SIGINT). Throws on anything unexpected - the
 * supervisor in main() tears the session down and starts a fresh one.
 */
async function runSession(shared: SharedState): Promise<void> {
  const context = await getContext();
  const market = context.markets.find((m) => m.id === config.marketId);
  if (!market) throw new Error(`Market ${config.marketId} not found in context`);
  console.log(
    `Trading ${market.symbol}: priceDecimals=${market.config.price_decimals} ` +
      `sizeDecimals=${market.config.size_decimals} makerFee=${market.config.maker_fee} takerFee=${market.config.taker_fee}`
  );

  const marketData = new MarketDataClient(config.marketId);
  const trading = new TradingClient();
  trading.setMarketMeta(market.id, {
    symbol: market.symbol,
    priceDecimals: market.config.price_decimals,
    sizeDecimals: market.config.size_decimals,
  });
  try {
    marketData.on("error", (err) => console.error("[market-data] error:", err));
    marketData.connect();
    await waitForEvent(marketData, "book", 15000);

    trading.on("error", (err) => console.error("[trading] error:", err));
    trading.on("close", (code) => {
      console.warn(`[trading] connection closed (code ${code}), reconnecting...`);
      logEvent("ws_closed", { socket: "trading", code });
    });
    trading.connect();
    await waitForEvent(trading, "authenticated", 15000);
    console.log(`Authenticated. accountId=${trading.getAccountId()}`);

    // currentBlock is only populated by the first Heartbeat; placing orders before
    // that gives them a bogus (near-zero) expiry block that's already "expired" on
    // the real chain, and the server silently drops them with no status response.
    await waitForEvent(trading, "heartbeat", 15000);
    console.log(`Chain head block: ${trading.getCurrentBlock()}`);

    // The positions snapshot (mt 26) lands around auth; if it already arrived the
    // cache is populated and this just times out quietly.
    await waitForEvent(trading, "positions", 8000).catch(() => undefined);
    await closeLeftoverPosition(trading, market.id);

    // Fires once per successfully connected session (initial start AND any
    // supervisor auto-recovery reconnect) - this is the earliest point that
    // genuinely confirms both WS feeds, auth, and chain sync all worked, not
    // just that the process launched.
    // Cold start (or any restart) begins at the cost ladder's floor, not
    // notionalUsd - see ladderNotionalUsd. Say so here rather than claiming the
    // configured max, which is what will actually happen only once cycles prove
    // it's cheap.
    const startingNotionalUsd = config.costLadderCycles > 0 ? config.costLadderNotionalFloor : config.notionalUsd;
    await sendNtfyMessage(
      "Perpl Bot - connected",
      startingNotionalUsd === config.notionalUsd
        ? `Notional: $${config.notionalUsd}/leg at ${config.leverage}x`
        : `Notional: starting at $${startingNotionalUsd} (floor), up to $${config.notionalUsd} max, at ${config.leverage}x`
    );

    const metrics = new MetricsTracker();

    // Deposit balance for the xlsx log: "wallet" carries the full account list
    // (snapshot + updates), "account" carries single-account push updates (mt 21).
    // Whichever arrives first sets initialBalanceUsd; every arrival refreshes
    // currentBalanceUsd, so the log always reflects the latest known deposit.
    const updateBalance = (rawBalance: unknown) => {
      const balanceUsd = Number(rawBalance) / 1e6;
      if (!Number.isFinite(balanceUsd)) return;
      if (shared.initialBalanceUsd == null) shared.initialBalanceUsd = balanceUsd;
      shared.currentBalanceUsd = balanceUsd;
    };
    trading.on("wallet", (wallet: Wallet) => {
      const acc = config.accountId ? wallet.as?.find((a) => a.id === config.accountId) : wallet.as?.[0];
      if (acc) updateBalance(acc.b);
    });
    trading.on("account", (account: Account) => {
      if (account.id === trading.getAccountId()) updateBalance(account.b);
    });

    // Volume/fees counted from the exchange's own fill stream (mt: 25) rather than
    // our order traces - traces have missed fills that landed during cancel races,
    // which made the old counter undershoot real volume by ~40% in testing.
    const priceScale = 10 ** market.config.price_decimals;
    const sizeScale = 10 ** market.config.size_decimals;
    trading.on("fills", (fills: import("./types.js").Fill[]) => {
      for (const f of fills) {
        if (f.mkt !== market.id) continue;
        // Skip fills already counted by an earlier session (see seenFillKeys).
        const key = `${f.at.b}:${f.at.tx}:${f.at.l ?? 0}:${f.oid}`;
        if (shared.seenFillKeys.has(key)) continue;
        shared.seenFillKeys.add(key);
        shared.totalVolumeUsd += ((f.p ?? 0) / priceScale) * (f.s / sizeScale);
        shared.totalFeesUsd += Number(f.f) / 1e6; // AUSD, 6 decimals
      }
    });

    while (!shared.stopRequested) {
      if (config.targetVolumeUsd > 0 && shared.totalVolumeUsd >= config.targetVolumeUsd) {
        console.log(
          `Reached target volume ($${shared.totalVolumeUsd.toFixed(2)} >= $${config.targetVolumeUsd}). Stopping.`
        );
        return;
      }
      if (config.maxRuntimeMin > 0 && Date.now() - shared.runStartMs >= config.maxRuntimeMin * 60_000) {
        console.log(`Reached max runtime (${config.maxRuntimeMin} min). Stopping.`);
        return;
      }

      // Trend guard: opening into a trending market gets adversely selected maker
      // fills that close at a worse price. Wait for chop instead of paying for it.
      if (config.trendGuardMaxDriftBps > 0) {
        const drift = marketData.getMidDriftBps(config.trendGuardWindowMs);
        if (drift != null && drift > config.trendGuardMaxDriftBps) {
          console.log(
            `[trend-guard] mid moved ${drift.toFixed(2)}bps in ${(config.trendGuardWindowMs / 1000).toFixed(0)}s ` +
              `(> ${config.trendGuardMaxDriftBps}bps) - waiting for calmer market`
          );
          logEvent("trend_guard_wait", {
            driftBps: drift,
            thresholdBps: config.trendGuardMaxDriftBps,
            windowMs: config.trendGuardWindowMs,
          });
          // Recheck every 1s (the drift check is local and free) - resumes trading
          // sooner after a trend cools instead of overshooting the wait by up to 2s.
          await sleep(1000);
          continue;
        }
      }

      shared.cycleId++;
      const cycleId = shared.cycleId;
      const side = shared.side;
      const openMid = marketData.getMid();
      if (openMid == null) {
        await sleep(500);
        continue;
      }
      const openReferenceMid = fromScaled(openMid, market.config.price_decimals);

      if (config.costLadderCycles > 0) {
        const costPerMillion = costPerMillionUsd(shared.recentCycles, config.costLadderCycles);
        // The bottom rung still has to be an order the exchange will accept:
        // min_posting_amount is the market's own minimum (an Amount, i.e. a decimal
        // string in scaled size units) and is read nowhere else in this codebase, so
        // without this a floor beneath it would make every open unfillable. Falls back
        // to 0 when the market omits it, leaving the configured floor to stand.
        const minPostingSize = Number(market.config.min_posting_amount ?? 0) || 0;
        const minPostingUsd = fromScaled(minPostingSize, market.config.size_decimals) * openReferenceMid;
        const floorUsd = Math.max(config.costLadderNotionalFloor, minPostingUsd);
        const next = ladderNotionalUsd(costPerMillion, floorUsd);

        // One-time push the moment there's enough data to judge cost at all - "where
        // we start" for this run, independent of whether that reading actually moves
        // the rung. costPerMillion is already the total (fees + PnL drag), never fees
        // alone - see cycleAllInCostUsd in metrics.ts.
        if (costPerMillion != null && !shared.costLadderFirstReadingSent) {
          shared.costLadderFirstReadingSent = true;
          const windowVolumeUsd = shared.recentCycles.reduce((sum, c) => sum + c.volumeUsd, 0);
          await sendNtfyMessage(
            "Perpl Bot - first cost reading",
            `Total cost (fees + PnL drag) over the first ${shared.recentCycles.length} cycles: ` +
              `$${costPerMillion.toFixed(2)}/1M on $${windowVolumeUsd.toFixed(2)} volume.\n` +
              `Notional now $${next.toFixed(2)}/leg.`
          );
        }

        if (next !== shared.currentNotionalUsd) {
          console.log(
            `[cost-ladder] $${costPerMillion?.toFixed(1) ?? "n/a"}/1M over last ${shared.recentCycles.length} cycles ` +
              `- notional $${shared.currentNotionalUsd.toFixed(2)} -> $${next.toFixed(2)}`
          );
          // Only on a change - measured on the historical logs that is once per ~8
          // cycles, where logging every cycle would add ~25k rows per run. Same
          // reasoning for the ntfy push below (asked for explicitly, unlike the
          // periodic summary/first-reading pushes above - expect it fairly often).
          logEvent("cost_ladder", {
            costPerMillionUsd: costPerMillion,
            cycles: shared.recentCycles.length,
            fromNotionalUsd: shared.currentNotionalUsd,
            toNotionalUsd: next,
            floorUsd,
          });
          // Skip the push (not the log/event above) for the very first, data-less
          // assignment at session start - the "connected" message already announced
          // "starting at the floor," so this would just repeat it with a confusing
          // "$400 -> $9" using a shared.currentNotionalUsd that was never traded.
          if (costPerMillion != null) {
            await sendNtfyMessage(
              "Perpl Bot - notional changed",
              `Cost (last ${shared.recentCycles.length} cycles): $${costPerMillion.toFixed(2)}/1M\n` +
                `Notional: $${shared.currentNotionalUsd.toFixed(2)} -> $${next.toFixed(2)}`
            );
          }
          shared.currentNotionalUsd = next;
        }
      }

      console.log(`[cycle ${cycleId}] opening ${side} ~$${shared.currentNotionalUsd.toFixed(2)} @ ${config.leverage}x`);
      let openedAtMs = Date.now();
      const openTrace = await openMakerThenTaker({
        trading,
        marketData,
        market,
        side,
        notionalUsd: shared.currentNotionalUsd,
      });

      let position;
      if (openTrace.filledSize === 0) {
        // The trace says nothing filled, but a fill can land during a cancel race or
        // arrive without any status update - poll briefly before trusting the skip.
        // A position appearing here means the open DID succeed silently.
        position = await waitForOpenedPosition(trading, market.id, 8000);
        if (!position) {
          // Flip sides before retrying: a chase that can't fill usually means price is
          // trending away from this side - the opposite side fills easily in a trend.
          console.warn(
            `[cycle ${cycleId}] open did not fill (verified no position), flipping to ${side === "long" ? "short" : "long"} and retrying`
          );
          logEvent("cycle_skipped", {
            cycleId,
            side,
            notionalUsd: shared.currentNotionalUsd,
            chaseAttempts: openTrace.chaseAttempts,
            flippedTo: side === "long" ? "short" : "long",
          });
          shared.side = side === "long" ? "short" : "long";
          // Same jittered rest as a completed cycle - the old fixed cycleRestMs (1s)
          // doubled the pause on exactly the cycles that already produced no volume.
          await sleep(cycleRestDelayMs());
          continue;
        }
        console.warn(`[cycle ${cycleId}] trace reported no fill but a position exists - proceeding to close it`);
      } else {
        position = await waitForOpenedPosition(trading, market.id, config.positionConfirmTimeoutMs);
        if (!position) {
          throw new Error(
            `[cycle ${cycleId}] filled ${openTrace.filledSize} but could not confirm the resulting position`
          );
        }
      }
      if (position.ots?.t) openedAtMs = position.ots.t;

      const watchdog = armHardTimeoutForceClose(trading, market, position.pid, side === "long", position.s);
      try {
        console.log(`[cycle ${cycleId}] position ${position.pid} open (size=${position.s}), closing...`);
        const closeReferenceMidScaled = marketData.getMid();
        const closeReferenceMid =
          closeReferenceMidScaled != null
            ? fromScaled(closeReferenceMidScaled, market.config.price_decimals)
            : openReferenceMid;

        // An IOC close can partially fill if the book moves beyond the slippage cap -
        // retry against whatever remains open until the position is actually gone.
        let closeTrace = await closeMakerThenTaker({
          trading,
          marketData,
          market,
          positionId: position.pid,
          isLong: side === "long",
          size: position.s,
        });
        for (let retry = 1; retry <= 5; retry++) {
          // Event-driven: resolves the instant the PositionsUpdate confirms the close
          // (typically a few hundred ms), instead of a fixed 1s sleep per attempt.
          if (await waitForPositionGone(trading, market.id, 2000)) break;
          const stillOpen = trading.findOpenPositionForMarket(market.id);
          if (!stillOpen) break;
          console.warn(
            `[cycle ${cycleId}] position still open after close attempt (size=${stillOpen.s}), retry ${retry}/5`
          );
          closeTrace = await closeMakerThenTaker({
            trading,
            marketData,
            market,
            positionId: stillOpen.pid,
            isLong: side === "long",
            size: stillOpen.s,
          });
        }
        const closedAtMs = Date.now();

        if (trading.findOpenPositionForMarket(market.id)) {
          throw new Error(`[cycle ${cycleId}] could not fully close the position after retries`);
        }

        const closedPos = trading.getPosition(position.pid);
        const pnlUsd = Number(closedPos?.dpnl ?? "0") / 1e6;
        shared.totalPnlUsd += pnlUsd;

        const summary = metrics.recordCycle({
          cycleId,
          marketId: market.id,
          side,
          priceDecimals: market.config.price_decimals,
          sizeDecimals: market.config.size_decimals,
          openReferenceMid,
          closeReferenceMid,
          openTrace,
          closeTrace,
          openedAtMs,
          closedAtMs,
          pnlUsd,
          notionalUsd: shared.currentNotionalUsd,
        });

        shared.recentCycles.push({ costUsd: cycleAllInCostUsd(summary), volumeUsd: summary.volumeUsd });
        // Trim to the window. This array outlives sessions, so it must not grow
        // unbounded across a multi-day run.
        const keepCycles = Math.max(config.costLadderCycles, 1);
        if (shared.recentCycles.length > keepCycles) {
          shared.recentCycles.splice(0, shared.recentCycles.length - keepCycles);
        }
        console.log(
          `[cycle ${cycleId}] done: PnL ${pnlUsd < 0 ? "-" : "+"}$${Math.abs(pnlUsd).toFixed(2)}, ` +
            `held ${((summary.holdTimeMs ?? 0) / 1000).toFixed(1)}s ` +
            `(makerFill=${(summary.makerFillRatio * 100).toFixed(0)}% ` +
            `openAdv=${summary.openAdverseBps?.toFixed(2) ?? "n/a"}bps closeAdv=${summary.closeAdverseBps?.toFixed(2) ?? "n/a"}bps)`
        );
        console.log(
          `[totals] volume=$${shared.totalVolumeUsd.toFixed(2)} fees=$${shared.totalFeesUsd.toFixed(4)} ` +
            `(${shared.totalVolumeUsd > 0 ? ((shared.totalFeesUsd / shared.totalVolumeUsd) * 10000).toFixed(2) : "0"}bps = ` +
            `$${shared.totalVolumeUsd > 0 ? ((shared.totalFeesUsd / shared.totalVolumeUsd) * 1e6).toFixed(0) : "0"}/1M)`
        );

        await logCloseToXlsx({
          atMs: closedAtMs,
          runStartMs: shared.runStartMs,
          cumulativeFeesUsd: shared.totalFeesUsd,
          cumulativePnlUsd: shared.totalPnlUsd,
          initialBalanceUsd: shared.initialBalanceUsd,
          currentBalanceUsd: shared.currentBalanceUsd,
          cumulativeVolumeUsd: shared.totalVolumeUsd,
        });

        // Frequent pulse: ntfy only, no xlsx row (it would bloat the sheet).
        if (closedAtMs - shared.periodStartMs >= SUMMARY_INTERVAL_MS) {
          const periodStartMs = shared.periodStartMs;
          // Format before rolling the window forward - the message reports the
          // period's own volume off the window's opening volume.
          const summaryMessage = formatPeriodSummaryMessage(
            shared,
            periodStartMs,
            closedAtMs,
            shared.periodStartVolumeUsd
          );
          shared.periodStartMs = closedAtMs;
          shared.periodStartVolumeUsd = shared.totalVolumeUsd;
          await sendNtfyMessage(`Perpl Bot - ${config.summaryIntervalHours}h summary`, summaryMessage);
        }

        // Slower full report: ntfy + the xlsx snapshot row, as before.
        if (closedAtMs - shared.reportStartMs >= REPORT_INTERVAL_MS) {
          const reportStartMs = shared.reportStartMs;
          const reportMessage = formatPeriodSummaryMessage(
            shared,
            reportStartMs,
            closedAtMs,
            shared.reportStartVolumeUsd
          );
          shared.reportStartMs = closedAtMs;
          shared.reportStartVolumeUsd = shared.totalVolumeUsd;
          await logPeriodSnapshotToXlsx(
            {
              atMs: closedAtMs,
              runStartMs: shared.runStartMs,
              cumulativeFeesUsd: shared.totalFeesUsd,
              cumulativePnlUsd: shared.totalPnlUsd,
              initialBalanceUsd: shared.initialBalanceUsd,
              currentBalanceUsd: shared.currentBalanceUsd,
              cumulativeVolumeUsd: shared.totalVolumeUsd,
            },
            reportStartMs
          );
          await sendNtfyMessage(`Perpl Bot - ${config.reportIntervalHours}h report`, reportMessage);
        }
      } finally {
        watchdog.cancel();
      }

      shared.side = side === "long" ? "short" : "long";
      await sleep(cycleRestDelayMs());
    }
  } finally {
    trading.disconnect();
    marketData.disconnect();
  }
}

const RECOVERY_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * Supervisor: keeps the bot up. Any session error (WS drop mid-cycle, uncertain
 * position state, auth timeout, ...) tears the whole session down; after a backoff
 * a fresh session reconnects and flattens any leftover position before trading
 * resumes. Only clean stops (SIGINT, target volume, max runtime) or repeated
 * failures with zero completed cycles end the process.
 */
async function main() {
  console.log(`Starting bot on ${config.network} (chain ${config.chainId}), market ${config.marketId}`);

  const shared: SharedState = {
    cycleId: 0,
    side: "long",
    totalVolumeUsd: 0,
    totalFeesUsd: 0,
    totalPnlUsd: 0,
    seenFillKeys: new Set(),
    runStartMs: Date.now(),
    periodStartMs: Date.now(),
    periodStartVolumeUsd: 0,
    reportStartMs: Date.now(),
    reportStartVolumeUsd: 0,
    stopRequested: false,
    currentNotionalUsd: config.notionalUsd,
    recentCycles: [],
    costLadderFirstReadingSent: false,
  };

  // SIGINT (Ctrl+C in a foreground terminal) and SIGTERM (pm2 stop, plain `kill`,
  // systemd, most process managers) both request a graceful stop the same way -
  // finish whatever cycle is in flight (so no position is left open and every
  // log gets its final row) before exiting. Without a SIGTERM handler, Node's
  // default behavior is to terminate immediately, mid-cycle, on any of those.
  const requestStop = (signal: string) => {
    console.log(`\n[${signal}] stopping after the current cycle finishes...`);
    shared.stopRequested = true;
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  let consecutiveFailures = 0;
  while (true) {
    const cyclesBefore = shared.cycleId;
    try {
      await runSession(shared);
      break; // clean stop
    } catch (err) {
      if (shared.cycleId > cyclesBefore) consecutiveFailures = 0; // the session made progress before dying
      consecutiveFailures++;
      console.error(`[supervisor] session failed (${consecutiveFailures} consecutive):`, err);
      logEvent("session_failure", {
        consecutiveFailures,
        cyclesCompletedTotal: shared.cycleId,
        error: (err as Error).message,
      });
      if (shared.stopRequested) break;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[supervisor] ${MAX_CONSECUTIVE_FAILURES} consecutive failures without a completed cycle - stopping for manual review`
        );
        logEvent("session_giveup", { consecutiveFailures });
        process.exitCode = 1;
        break;
      }
      const backoff = RECOVERY_BACKOFF_MS[Math.min(consecutiveFailures - 1, RECOVERY_BACKOFF_MS.length - 1)] ?? 300_000;
      console.log(`[supervisor] restarting in ${backoff / 1000}s...`);
      logEvent("session_backoff", { backoffMs: backoff, consecutiveFailures });
      await sleep(backoff);
      if (shared.stopRequested) break;
    }
  }
  console.log("Stopped.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

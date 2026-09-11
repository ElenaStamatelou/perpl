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
import { MetricsTracker, costPerMillionUsd } from "./metrics.js";
import { OrderFlags, OrderType, type Account, type Position, type Wallet } from "./types.js";
import { logCloseToXlsx, logPeriodSnapshotToXlsx } from "./xlsxLog.js";
import { sendNtfyMessage } from "./ntfyNotifier.js";
import { ladderNotionalUsd } from "./costLadder.js";

// Two cadences: the "past N hours" report (also writes the xlsx snapshot row) and
// the slower "since start" full summary.
const REPORT_INTERVAL_MS = config.reportIntervalHours * 60 * 60 * 1000;
const FULL_SUMMARY_INTERVAL_MS = config.fullSummaryIntervalHours * 60 * 60 * 1000;

/** $12,345,678 -> "$12.35M". Volumes run to millions, so raw dollars are unreadable at a glance. */
function fmtMillions(usd: number): string {
  return `$${(usd / 1e6).toFixed(2)}M`;
}

/**
 * Buckets for "how much time did the cost ladder spend at roughly what notional,
 * and how expensive was trading while it was there" - both expressed as fractions
 * of config.notionalUsd (the ladder's full size) so the buckets stay meaningful
 * regardless of what NOTIONAL_USD/COST_LADDER_NOTIONAL_FLOOR are set to.
 */
const NOTIONAL_RANGES = [
  { label: "Full", minFrac: 0.8 },
  { label: "High", minFrac: 0.5 },
  { label: "Mid", minFrac: 0.2 },
  { label: "Low", minFrac: 0.05 },
  { label: "Floor", minFrac: -Infinity },
] as const;
type RangeLabel = (typeof NOTIONAL_RANGES)[number]["label"];

type RangeStats = Record<RangeLabel, { timeMs: number; feeUsd: number; pnlUsd: number; volumeUsd: number }>;

function freshRangeStats(): RangeStats {
  const stats = {} as RangeStats;
  for (const r of NOTIONAL_RANGES) stats[r.label] = { timeMs: 0, feeUsd: 0, pnlUsd: 0, volumeUsd: 0 };
  return stats;
}

function notionalRangeLabel(notionalUsd: number, maxUsd: number): RangeLabel {
  const frac = maxUsd > 0 ? notionalUsd / maxUsd : 0;
  for (const r of NOTIONAL_RANGES) {
    if (frac >= r.minFrac) return r.label;
  }
  return "Floor";
}

/** Human $ bounds for a range's label, e.g. "Full" at maxUsd=400 -> ">=$320". */
function rangeBoundsLabel(label: RangeLabel, maxUsd: number): string {
  const idx = NOTIONAL_RANGES.findIndex((r) => r.label === label);
  const lo = NOTIONAL_RANGES[idx]!.minFrac;
  const hi = idx > 0 ? NOTIONAL_RANGES[idx - 1]!.minFrac : Infinity;
  if (hi === Infinity) return `>=$${(maxUsd * lo).toFixed(0)}`;
  if (lo === -Infinity) return `<$${(maxUsd * hi).toFixed(0)}`;
  return `$${(maxUsd * lo).toFixed(0)}-${(maxUsd * hi).toFixed(0)}`;
}

function addCycleToRangeStats(
  stats: RangeStats,
  label: RangeLabel,
  elapsedMs: number,
  cycle: { feeUsd: number; pnlUsd: number; volumeUsd: number }
): void {
  const bucket = stats[label];
  bucket.timeMs += elapsedMs;
  bucket.feeUsd += cycle.feeUsd;
  bucket.pnlUsd += cycle.pnlUsd;
  bucket.volumeUsd += cycle.volumeUsd;
}

/**
 * Renders the "how much time at what notional, and how expensive" breakdown.
 * Skips ranges the ladder never visited in this window, so a mostly-full or
 * mostly-floor period doesn't print empty rows.
 */
function formatRangeBreakdown(stats: RangeStats, maxUsd: number): string {
  const totalMs = NOTIONAL_RANGES.reduce((s, r) => s + stats[r.label].timeMs, 0);
  if (totalMs <= 0) return "";
  const lines = NOTIONAL_RANGES.map((r) => {
    const s = stats[r.label];
    if (s.timeMs <= 0) return null;
    const pct = (s.timeMs / totalMs) * 100;
    const costPerMillion = s.volumeUsd > 0 ? ((s.feeUsd - s.pnlUsd) / s.volumeUsd) * 1e6 : null;
    const costStr = costPerMillion != null ? `$${costPerMillion.toFixed(0)}/1M` : "n/a";
    return `  ${r.label} ${rangeBoundsLabel(r.label, maxUsd)}: ${pct.toFixed(0)}% time, ${costStr}`;
  }).filter((l): l is string => l != null);
  return lines.join("\n");
}

/**
 * The "past N hours" report push: this period's volume/cost/notional-range mix,
 * not the running totals since start (that's formatFullSummaryMessage below).
 */
function formatPeriodReportMessage(
  shared: SharedState,
  periodStartMs: number,
  periodEndMs: number,
  periodStartVolumeUsd: number,
  periodStartFeesUsd: number,
  periodStartPnlUsd: number,
  rangeStats: RangeStats
): string {
  const periodVolume = shared.totalVolumeUsd - periodStartVolumeUsd;
  const periodFees = shared.totalFeesUsd - periodStartFeesUsd;
  const periodPnl = shared.totalPnlUsd - periodStartPnlUsd;
  const periodNetCost = periodFees - periodPnl;
  const periodCostPerMillion = periodVolume > 0 ? (periodNetCost / periodVolume) * 1e6 : 0;
  const periodHours = (periodEndMs - periodStartMs) / 3_600_000;
  const periodVolPerHour = periodHours > 0 ? periodVolume / periodHours : 0;
  const pnlStr = `${periodPnl >= 0 ? "+" : "-"}$${Math.abs(periodPnl).toFixed(2)}`;
  const deposit = shared.currentBalanceUsd != null ? `$${shared.currentBalanceUsd.toFixed(2)}` : "n/a";
  const breakdown = formatRangeBreakdown(rangeStats, config.notionalUsd);
  return (
    `Notional $${shared.currentNotionalUsd.toFixed(0)}. Deposit ${deposit}.\n` +
    `\n` +
    `Past ${periodHours.toFixed(1)}h: ${fmtMillions(periodVolume)} volume (${fmtMillions(periodVolPerHour)}/h), cost $${periodCostPerMillion.toFixed(0)}/1M.\n` +
    `Fees $${periodFees.toFixed(2)}, PnL ${pnlStr}, net cost $${periodNetCost.toFixed(2)}.` +
    (breakdown ? `\n\nNotional time:\n${breakdown}` : "")
  );
}

/**
 * The "since start" full summary push - running totals for the whole run, sent
 * roughly once a day rather than on every report cadence.
 */
function formatFullSummaryMessage(shared: SharedState, nowMs: number): string {
  const hoursRunning = (nowMs - shared.runStartMs) / 3_600_000;
  const netCost = shared.totalFeesUsd - shared.totalPnlUsd;
  const costPerMillion = shared.totalVolumeUsd > 0 ? (netCost / shared.totalVolumeUsd) * 1e6 : 0;
  const pnl = shared.totalPnlUsd;
  const pnlStr = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;
  const deposit = shared.currentBalanceUsd != null ? `$${shared.currentBalanceUsd.toFixed(2)}` : "n/a";
  const breakdown = formatRangeBreakdown(shared.lifetimeRangeStats, config.notionalUsd);
  return (
    `Running ${hoursRunning.toFixed(1)}h. Notional $${shared.currentNotionalUsd.toFixed(0)}. Deposit ${deposit}.\n` +
    `\n` +
    `Since start: ${fmtMillions(shared.totalVolumeUsd)} volume, cost $${costPerMillion.toFixed(0)}/1M.\n` +
    `Fees $${shared.totalFeesUsd.toFixed(2)}, PnL ${pnlStr}, net cost $${netCost.toFixed(2)}.` +
    (breakdown ? `\n\nNotional time:\n${breakdown}` : "")
  );
}

/**
 * Notional a fresh process actually starts trading at: the cost ladder's floor
 * when it's enabled (a null cost - no cycle history yet - maps to the smallest
 * notional on the curve, see ladderNotionalUsd), otherwise the configured max.
 * Used both for the "connected" message and to seed SharedState's notional
 * fields, so they can't drift apart and misreport the first ladder move after
 * a restart as a jump from the configured max (which was never actually traded).
 */
function coldStartNotionalUsd(): number {
  return config.costLadderCycles > 0 ? config.costLadderNotionalFloor : config.notionalUsd;
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
  // Start of the current report window (REPORT_INTERVAL_MS) - survives restarts
  // same as the totals, so a mid-window restart doesn't reset the clock and
  // produce a short extra row. The report message covers only this window (see
  // formatPeriodReportMessage), so its fees/PnL are tracked from the same point.
  reportStartMs: number;
  reportStartVolumeUsd: number;
  reportStartFeesUsd: number;
  reportStartPnlUsd: number;
  // Wall-clock of the last "since start" full summary push (FULL_SUMMARY_INTERVAL_MS).
  fullSummaryStartMs: number;
  stopRequested: boolean;
  // Notional the cost ladder has chosen for the next open. Lives here rather than
  // on the session (or as a config mutation) so a session restart doesn't silently
  // snap size back to full - sessions died 172 times across the 3 weeks of logs.
  // Updated every cycle now (the ladder is a continuous line, not fixed rungs).
  currentNotionalUsd: number;
  // The notional value as of the last time a change was actually logged/notified.
  // Separate from currentNotionalUsd (which moves every cycle) so logging/alerting
  // can be throttled to "moved at least costLadderNotifyStepUsd" without that
  // throttling affecting what's actually traded.
  lastNotifiedNotionalUsd: number;
  // The notional value as of the last "notional changed" ntfy push. Separate from
  // lastNotifiedNotionalUsd (the log/event's own throttle) purely so each can be
  // read independently; both use the same costLadderNotifyStepUsd threshold and
  // no wall-clock cooldown - every qualifying move gets pushed immediately.
  lastPushedNotionalUsd: number;
  // Ring buffer of the last costLadderCycles cycles, feeding the ladder's cost/$1M.
  // On `shared` for the same reason: a session-scoped history would be empty after
  // every reconnect, and an empty history means the floor (see ladderNotionalUsd).
  // Fee and PnL are kept separate (not pre-collapsed into one cost figure) so the
  // ntfy pushes below can report the fees/1M + PnL-drag/1M breakdown, not just the
  // total - costPerMillionUsd derives costUsd = feeUsd - pnlUsd when it needs it.
  recentCycles: Array<{ feeUsd: number; pnlUsd: number; volumeUsd: number }>;
  // Set once the ladder's cost/$1M goes from "not enough data" to a real number for
  // the first time this process lifetime - gates the one-time ntfy push announcing
  // the starting reading, so it fires once per start/restart, not once per cycle.
  costLadderFirstReadingSent: boolean;
  // AUSD deposit balance, tracked from wallet/account push updates for the xlsx log.
  // initialBalanceUsd is captured once (first balance seen) and never overwritten.
  initialBalanceUsd?: number;
  currentBalanceUsd?: number;
  // Wall-clock of the last cycle close, so each cycle's notional can be credited
  // with the time that actually elapsed while it was active (open+close+rest),
  // for the "time spent in each notional range" breakdown below.
  lastCycleEndMs: number;
  // Time/fee/PnL/volume per notional range (see NOTIONAL_RANGES), two copies:
  // one reset every report window (REPORT_INTERVAL_MS), one that accumulates
  // for the whole run (fed into the "since start" full summary).
  reportRangeStats: RangeStats;
  lifetimeRangeStats: RangeStats;
}

/** Fees/$1M and PnL-drag/$1M (both positive-when-costly) over a set of cycles, for
 * ntfy messages that need the components, not just the total cost. */
function windowBreakdown(cycles: ReadonlyArray<{ feeUsd: number; pnlUsd: number; volumeUsd: number }>): {
  feePerMillion: number;
  pnlDragPerMillion: number;
  volumeUsd: number;
} {
  let feeUsd = 0;
  let pnlUsd = 0;
  let volumeUsd = 0;
  for (const c of cycles) {
    feeUsd += c.feeUsd;
    pnlUsd += c.pnlUsd;
    volumeUsd += c.volumeUsd;
  }
  return {
    feePerMillion: volumeUsd > 0 ? (feeUsd / volumeUsd) * 1e6 : 0,
    // Drag is -pnl: a loss (negative pnl) is positive drag, a gain offsets cost -
    // matches how this is shown everywhere else (watch-cost.ts, the cost writeups).
    pnlDragPerMillion: volumeUsd > 0 ? (-pnlUsd / volumeUsd) * 1e6 : 0,
    volumeUsd,
  };
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
    const startingNotionalUsd = coldStartNotionalUsd();
    await sendNtfyMessage(
      "Connected",
      `Trading ${market.symbol} at ${config.leverage}x.\n` +
        (startingNotionalUsd === config.notionalUsd
          ? `Notional: $${config.notionalUsd}.`
          : `Notional: starts $${startingNotionalUsd}, up to $${config.notionalUsd} as costs allow.`),
      { tags: "white_check_mark" }
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
        const costPerMillion = costPerMillionUsd(
          shared.recentCycles.map((c) => ({ costUsd: c.feeUsd - c.pnlUsd, volumeUsd: c.volumeUsd })),
          config.costLadderCycles
        );
        // The bottom rung still has to be an order the exchange will accept:
        // min_posting_amount is the market's own minimum (an Amount, i.e. a decimal
        // string in scaled size units) and is read nowhere else in this codebase, so
        // without this a floor beneath it would make every open unfillable. Falls back
        // to 0 when the market omits it, leaving the configured floor to stand.
        const minPostingSize = Number(market.config.min_posting_amount ?? 0) || 0;
        const minPostingUsd = fromScaled(minPostingSize, market.config.size_decimals) * openReferenceMid;
        const floorUsd = Math.max(config.costLadderNotionalFloor, minPostingUsd);
        const next = ladderNotionalUsd(costPerMillion, floorUsd);
        // The traded size updates every cycle now - the scale is continuous, so
        // there's no "rung" to wait for. Logging/alerting is throttled separately
        // below; this line is unconditional.
        shared.currentNotionalUsd = next;

        // One-time push the moment there's enough data to judge cost at all - "where
        // we start" for this run, independent of whether that reading actually moves
        // size. costPerMillion is already the total (fees + PnL drag), never fees
        // alone - see cycleAllInCostUsd in metrics.ts.
        if (costPerMillion != null && !shared.costLadderFirstReadingSent) {
          shared.costLadderFirstReadingSent = true;
          const { feePerMillion, pnlDragPerMillion } = windowBreakdown(shared.recentCycles);
          await sendNtfyMessage(
            "First cost reading",
            `Cost so far: $${costPerMillion.toFixed(0)}/1M ` +
              `(fees $${feePerMillion.toFixed(0)} + PnL drag $${pnlDragPerMillion.toFixed(0)}).\n` +
              `Trading notional now $${next.toFixed(0)}.`,
            { tags: "bar_chart" }
          );
        }

        // Log/notify only once size has drifted at least costLadderNotifyStepUsd from
        // the last announced value - on a continuous scale, comparing to the PRIOR
        // cycle's value would fire almost every cycle (each one differs slightly as
        // the rolling window shifts), which is what the old exact-inequality check
        // effectively degenerated into once rungs became a smooth line.
        if (Math.abs(next - shared.lastNotifiedNotionalUsd) >= config.costLadderNotifyStepUsd) {
          const from = shared.lastNotifiedNotionalUsd;
          console.log(
            `[cost-ladder] $${costPerMillion?.toFixed(1) ?? "n/a"}/1M over last ${shared.recentCycles.length} cycles ` +
              `- notional $${from.toFixed(2)} -> $${next.toFixed(2)}`
          );
          logEvent("cost_ladder", {
            costPerMillionUsd: costPerMillion,
            cycles: shared.recentCycles.length,
            fromNotionalUsd: from,
            toNotionalUsd: next,
            floorUsd,
          });
          shared.lastNotifiedNotionalUsd = next;
        }

        // Every qualifying move gets pushed immediately - no wall-clock cooldown.
        // Only gate left is the step threshold, so sub-$step wiggles on the
        // continuous scale don't spam a push every cycle.
        //
        // costPerMillion == null is the very first, data-less assignment at session
        // start - skipped here (not the log/event): the "connected" message already
        // said "starting at the floor," so this would repeat it as a confusing
        // "$400 -> $3" using a notional that was never actually traded.
        const pushDrift = Math.abs(next - shared.lastPushedNotionalUsd);
        if (costPerMillion != null && pushDrift >= config.costLadderNotifyStepUsd) {
          const { feePerMillion, pnlDragPerMillion } = windowBreakdown(shared.recentCycles);
          const goingDown = next < shared.lastPushedNotionalUsd;
          await sendNtfyMessage(
            `Notional ${goingDown ? "down" : "up"} to $${next.toFixed(0)}`,
            `Cost now $${costPerMillion.toFixed(0)}/1M ` +
              `(fees $${feePerMillion.toFixed(0)} + PnL drag $${pnlDragPerMillion.toFixed(0)}).\n` +
              `Notional: $${shared.lastPushedNotionalUsd.toFixed(0)} -> $${next.toFixed(0)}.`,
            { tags: goingDown ? "chart_with_downwards_trend" : "chart_with_upwards_trend" }
          );
          shared.lastPushedNotionalUsd = next;
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

        const cycleCost = {
          feeUsd: (summary.bpsBurned / 10000) * summary.volumeUsd,
          pnlUsd: summary.pnlUsd ?? 0,
          volumeUsd: summary.volumeUsd,
        };
        shared.recentCycles.push(cycleCost);
        // Trim to the window. This array outlives sessions, so it must not grow
        // unbounded across a multi-day run.
        const keepCycles = Math.max(config.costLadderCycles, 1);
        if (shared.recentCycles.length > keepCycles) {
          shared.recentCycles.splice(0, shared.recentCycles.length - keepCycles);
        }

        // Credit this cycle's notional range with the wall-clock time that just
        // elapsed (open+close+rest), for the "time spent per notional range"
        // breakdown in the report/full-summary pushes below.
        const cycleElapsedMs = Math.max(0, closedAtMs - shared.lastCycleEndMs);
        shared.lastCycleEndMs = closedAtMs;
        const rangeLabel = notionalRangeLabel(shared.currentNotionalUsd, config.notionalUsd);
        addCycleToRangeStats(shared.reportRangeStats, rangeLabel, cycleElapsedMs, cycleCost);
        addCycleToRangeStats(shared.lifetimeRangeStats, rangeLabel, cycleElapsedMs, cycleCost);
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

        // "Past N hours" report: ntfy + the xlsx snapshot row, covering only this
        // window (not the running totals since start - see formatFullSummaryMessage
        // below for that).
        if (closedAtMs - shared.reportStartMs >= REPORT_INTERVAL_MS) {
          const reportStartMs = shared.reportStartMs;
          // Format before rolling the window forward - the message reports the
          // period's own volume/fees/PnL off the window's opening figures.
          const reportMessage = formatPeriodReportMessage(
            shared,
            reportStartMs,
            closedAtMs,
            shared.reportStartVolumeUsd,
            shared.reportStartFeesUsd,
            shared.reportStartPnlUsd,
            shared.reportRangeStats
          );
          shared.reportStartMs = closedAtMs;
          shared.reportStartVolumeUsd = shared.totalVolumeUsd;
          shared.reportStartFeesUsd = shared.totalFeesUsd;
          shared.reportStartPnlUsd = shared.totalPnlUsd;
          shared.reportRangeStats = freshRangeStats();
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
          await sendNtfyMessage(`${config.reportIntervalHours}h report`, reportMessage, {
            tags: "clipboard",
          });
        }

        // "Since start" full summary: ntfy only, roughly once a day - the running
        // totals the report above deliberately no longer carries every time.
        if (closedAtMs - shared.fullSummaryStartMs >= FULL_SUMMARY_INTERVAL_MS) {
          const summaryMessage = formatFullSummaryMessage(shared, closedAtMs);
          shared.fullSummaryStartMs = closedAtMs;
          await sendNtfyMessage(`${config.fullSummaryIntervalHours}h summary`, summaryMessage, {
            tags: "hourglass_flowing_sand",
          });
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
    reportStartMs: Date.now(),
    reportStartVolumeUsd: 0,
    reportStartFeesUsd: 0,
    reportStartPnlUsd: 0,
    fullSummaryStartMs: Date.now(),
    stopRequested: false,
    // See coldStartNotionalUsd - matches what the first cycle actually trades.
    currentNotionalUsd: coldStartNotionalUsd(),
    lastNotifiedNotionalUsd: coldStartNotionalUsd(),
    lastPushedNotionalUsd: coldStartNotionalUsd(),
    recentCycles: [],
    costLadderFirstReadingSent: false,
    lastCycleEndMs: Date.now(),
    reportRangeStats: freshRangeStats(),
    lifetimeRangeStats: freshRangeStats(),
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

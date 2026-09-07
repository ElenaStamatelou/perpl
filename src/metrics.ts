import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { fromScaled } from "./orderEngine.js";
import type { ExecutionTrace } from "./orderEngine.js";
import type { Order } from "./types.js";

const LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}cycles.jsonl`;

export type Side = "buy" | "sell";

// AUSD (the only collateral token on mainnet/testnet today - see /pub/context tokens[]) has 6 decimals.
const COLLATERAL_DECIMALS = 6;

/** avgFillPrice/referencePrice in human units. Positive = cost you relative to the reference (worse execution). */
export function adverseBps(side: Side, avgFillPrice: number, referencePrice: number): number {
  if (referencePrice === 0) return 0;
  const diff = side === "buy" ? avgFillPrice - referencePrice : referencePrice - avgFillPrice;
  return (diff / referencePrice) * 10000;
}

/** Fee paid relative to notional, in bps. Negative = net rebate. */
function feeBps(order: Order | undefined, priceDecimals: number, sizeDecimals: number): number {
  if (!order || order.fs === 0) return 0;
  const notional = fromScaled(order.fp, priceDecimals) * fromScaled(order.fs, sizeDecimals);
  if (notional === 0) return 0;
  const feeUsd = Number(order.f) / 10 ** COLLATERAL_DECIMALS;
  return (feeUsd / notional) * 10000;
}

function makerFilledSize(trace: ExecutionTrace): number {
  return trace.makerOrder?.fs ?? 0;
}

export interface CycleInput {
  cycleId: number;
  marketId: number;
  side: "long" | "short";
  priceDecimals: number;
  sizeDecimals: number;
  openReferenceMid: number; // human units, book mid at the moment we decided to open
  closeReferenceMid?: number; // human units, book mid at the moment we decided to close
  openTrace: ExecutionTrace;
  closeTrace?: ExecutionTrace;
  openedAtMs?: number;
  closedAtMs?: number;
  pnlUsd?: number; // realized dpnl from the exchange (excludes fees - verified against deposit deltas)
  // Notional actually used for this cycle. Not config.notionalUsd: the cost ladder
  // varies size at runtime, so reading the config here would record a size that was
  // never traded and make cycles.jsonl useless for auditing the ladder offline.
  notionalUsd: number;
}

export interface CycleSummary {
  ts: number; // when this cycle was recorded (closedAtMs) - cycles.jsonl had no timestamp before
  cycleId: number;
  marketId: number;
  side: "long" | "short";
  notionalUsd: number; // config at the time - lets cross-config comparisons (e.g. 400 vs 600) group directly
  openChaseAttempts: number; // straight from ExecutionTrace - only ever set for cycles that DID fill,
  // so this is a cleaner "attempts needed to fill" signal than reconstructing success/failure from raw order events
  volumeUsd: number;
  bpsBurned: number; // weighted across open+close legs
  makerFillRatio: number; // 0..1
  holdTimeMs?: number;
  openAdverseBps?: number;
  closeAdverseBps?: number;
  pnlUsd?: number; // per-cycle realized PnL, fee-exclusive - all-in cycle cost = fees - pnlUsd
  // Whether the taker fallback fired on each leg (trace.takerOrder set = maker
  // chase didn't finish the job in time). For closes specifically, this is the
  // number needed to answer "how often does CLOSE_MAKER_FIRST actually work"
  // - unmeasurable any other way since a taker-only close never attempts a
  // maker chase at all, so there's no historical data on close maker fill rate.
  openUsedTaker: boolean;
  closeUsedTaker?: boolean;
  closeChaseAttempts?: number; // 0 when closeMakerFirst=false (instant close skips the chase loop entirely)
  // Config snapshot beyond notionalUsd, so A/B runs of ANY knob can be grouped
  // offline by whatever changed.
  closeMakerFirst: boolean;
  maxTakerSlippageBps: number;
  trendGuardMaxDriftBps: number;
  chaseAbortDriftBps: number;
  makerChaseAttempts: number;
}

/**
 * All-in cost of one cycle in USD: fees paid, minus realized PnL. Same definition
 * as scripts/audit-run.ts (fees - PnL), so the in-process number and the offline
 * exchange audit are directly comparable.
 */
export function cycleAllInCostUsd(cycle: Pick<CycleSummary, "bpsBurned" | "volumeUsd" | "pnlUsd">): number {
  return (cycle.bpsBurned / 10000) * cycle.volumeUsd - (cycle.pnlUsd ?? 0);
}

/**
 * All-in cost per $1M of volume over the given cycles, or null when there are
 * fewer than minCycles to judge from (callers must treat null as "unknown", never
 * as "expensive"). Being a ratio, it reads correctly at any notional - which is
 * what lets the cost ladder measure its way back up from the floor.
 */
export function costPerMillionUsd(
  cycles: ReadonlyArray<{ costUsd: number; volumeUsd: number }>,
  minCycles: number
): number | null {
  if (cycles.length < minCycles) return null;
  let costUsd = 0;
  let volumeUsd = 0;
  for (const c of cycles) {
    costUsd += c.costUsd;
    volumeUsd += c.volumeUsd;
  }
  if (volumeUsd <= 0) return null;
  return (costUsd / volumeUsd) * 1e6;
}

export class MetricsTracker {
  private summaries: CycleSummary[] = [];

  recordCycle(input: CycleInput): CycleSummary {
    const { priceDecimals, sizeDecimals, openTrace, closeTrace } = input;
    const openIsBuy = input.side === "long"; // opening long = buying, opening short = selling
    const openAvgPrice = openTrace.makerOrder?.fp
      ? fromScaled(openTrace.makerOrder.fp, priceDecimals)
      : undefined;

    const openNotional =
      fromScaled(openTrace.filledSize, sizeDecimals) * (openAvgPrice ?? input.openReferenceMid);
    const closeNotional = closeTrace
      ? fromScaled(closeTrace.filledSize, sizeDecimals) *
        (closeTrace.makerOrder?.fp
          ? fromScaled(closeTrace.makerOrder.fp, priceDecimals)
          : input.closeReferenceMid ?? input.openReferenceMid)
      : 0;
    const volumeUsd = openNotional + closeNotional;

    const openFeeBps = combinedFeeBps(openTrace, priceDecimals, sizeDecimals);
    const closeFeeBps = closeTrace ? combinedFeeBps(closeTrace, priceDecimals, sizeDecimals) : 0;
    const bpsBurned =
      volumeUsd === 0
        ? 0
        : (openFeeBps * openNotional + closeFeeBps * closeNotional) / volumeUsd;

    const makerSize = makerFilledSize(openTrace) + (closeTrace ? makerFilledSize(closeTrace) : 0);
    const totalSize = openTrace.filledSize + (closeTrace?.filledSize ?? 0);
    const makerFillRatio = totalSize === 0 ? 0 : makerSize / totalSize;

    const holdTimeMs =
      input.openedAtMs != null && input.closedAtMs != null
        ? input.closedAtMs - input.openedAtMs
        : undefined;

    const openAvgFill = orderAvgFillPrice(openTrace, priceDecimals);
    const openAdverseBps =
      openAvgFill != null ? adverseBps(openIsBuy ? "buy" : "sell", openAvgFill, input.openReferenceMid) : undefined;

    let closeAdverseBps: number | undefined;
    if (closeTrace && input.closeReferenceMid != null) {
      const closeAvgFill = orderAvgFillPrice(closeTrace, priceDecimals);
      const closeIsBuy = !openIsBuy; // closing a long = selling, closing a short = buying
      if (closeAvgFill != null) {
        closeAdverseBps = adverseBps(closeIsBuy ? "buy" : "sell", closeAvgFill, input.closeReferenceMid);
      }
    }

    const summary: CycleSummary = {
      ts: input.closedAtMs ?? Date.now(),
      cycleId: input.cycleId,
      marketId: input.marketId,
      side: input.side,
      notionalUsd: input.notionalUsd,
      openChaseAttempts: openTrace.chaseAttempts,
      volumeUsd,
      bpsBurned,
      makerFillRatio,
      holdTimeMs,
      openAdverseBps,
      closeAdverseBps,
      pnlUsd: input.pnlUsd,
      openUsedTaker: openTrace.takerOrder != null,
      closeUsedTaker: closeTrace ? closeTrace.takerOrder != null : undefined,
      closeChaseAttempts: closeTrace?.chaseAttempts,
      closeMakerFirst: config.closeMakerFirst,
      maxTakerSlippageBps: config.maxTakerSlippageBps,
      trendGuardMaxDriftBps: config.trendGuardMaxDriftBps,
      chaseAbortDriftBps: config.chaseAbortDriftBps,
      makerChaseAttempts: config.makerChaseAttempts,
    };

    this.summaries.push(summary);
    appendFileSync(LOG_FILE, JSON.stringify(summary) + "\n");
    return summary;
  }

  getSummaries(): CycleSummary[] {
    return this.summaries;
  }

  printRunningTotals(): void {
    const n = this.summaries.length;
    if (n === 0) {
      console.log("No cycles recorded yet.");
      return;
    }
    const totalVolume = this.summaries.reduce((s, c) => s + c.volumeUsd, 0);
    const avgBps = this.summaries.reduce((s, c) => s + c.bpsBurned, 0) / n;
    const avgMakerRatio = this.summaries.reduce((s, c) => s + c.makerFillRatio, 0) / n;
    const holdTimes = this.summaries.map((c) => c.holdTimeMs).filter((v): v is number => v != null);
    const avgHoldMs = holdTimes.length ? holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length : undefined;

    console.log(
      `[metrics] cycles=${n} volume=$${totalVolume.toFixed(2)} avgBpsBurned=${avgBps.toFixed(2)} ` +
        `avgMakerFillRatio=${(avgMakerRatio * 100).toFixed(1)}% avgHoldMs=${avgHoldMs?.toFixed(0) ?? "n/a"}`
    );
  }
}

function orderAvgFillPrice(trace: ExecutionTrace, priceDecimals: number): number | undefined {
  // Volume-weighted across maker + taker legs.
  const legs: Array<{ price: number; size: number }> = [];
  if (trace.makerOrder?.fs) legs.push({ price: fromScaled(trace.makerOrder.fp, priceDecimals), size: trace.makerOrder.fs });
  if (trace.takerOrder?.fs) legs.push({ price: fromScaled(trace.takerOrder.fp, priceDecimals), size: trace.takerOrder.fs });
  const totalSize = legs.reduce((s, l) => s + l.size, 0);
  if (totalSize === 0) return undefined;
  return legs.reduce((s, l) => s + l.price * l.size, 0) / totalSize;
}

function combinedFeeBps(trace: ExecutionTrace, priceDecimals: number, sizeDecimals: number): number {
  const makerBps = feeBps(trace.makerOrder, priceDecimals, sizeDecimals);
  const takerBps = feeBps(trace.takerOrder, priceDecimals, sizeDecimals);
  const makerNotional = trace.makerOrder ? fromScaled(trace.makerOrder.fp, priceDecimals) * fromScaled(trace.makerOrder.fs, sizeDecimals) : 0;
  const takerNotional = trace.takerOrder ? fromScaled(trace.takerOrder.fp, priceDecimals) * fromScaled(trace.takerOrder.fs, sizeDecimals) : 0;
  const total = makerNotional + takerNotional;
  if (total === 0) return 0;
  return (makerBps * makerNotional + takerBps * takerNotional) / total;
}

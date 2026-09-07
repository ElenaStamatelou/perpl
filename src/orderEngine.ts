import { config } from "./config.js";
import { logEvent } from "./eventLog.js";
import type { TradingClient } from "./tradingClient.js";
import type { MarketDataClient } from "./marketDataClient.js";
import {
  ORDER_REASON_TEXT,
  OrderFlags,
  OrderStatus,
  OrderStatusReason,
  OrderType,
  type Market,
  type Order,
  type OrderRequest,
} from "./types.js";

function rejectReasonText(sr: OrderStatusReason): string {
  return ORDER_REASON_TEXT[sr] ?? OrderStatusReason[sr] ?? `code ${sr}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toScaled(value: number, decimals: number): number {
  return Math.round(value * 10 ** decimals);
}

export function fromScaled(value: number, decimals: number): number {
  return value / 10 ** decimals;
}

/**
 * initial_margin is a Fraction in hundredths; max leverage is initial_margin/100
 * (confirmed against live UI: BTC 1500->15x, MON 1000->10x, ETH/SOL 1200->12x,
 * HYPE 1000->10x, ZEC 800->8x).
 */
export function maxLeverageForMarket(market: Market): number {
  return Math.floor(market.config.initial_margin / 100);
}

function clampLeverage(requested: number, market: Market): number {
  const max = maxLeverageForMarket(market);
  if (requested > max) {
    console.warn(
      `[orderEngine] requested leverage ${requested}x exceeds ${market.symbol || market.name} max ${max}x - clamping`
    );
    return max;
  }
  return requested;
}

/** The server rejects lb (last exec block) beyond head_block + market.order_ttl_blocks (see rest-endpoints.md / websocket.md input validation notes). */
function clampExpiryBlocks(requested: number, market: Market): number {
  const max = market.order_ttl_blocks;
  if (requested > max) {
    console.warn(
      `[orderEngine] requested expiry ${requested} blocks exceeds ${market.symbol || market.name} order_ttl_blocks=${max} - clamping`
    );
    return max;
  }
  return requested;
}

const TERMINAL_STATUSES = new Set([
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Failed,
]);

/** Waits for an order (by oid) to reach a terminal state, or times out with whatever's known so far. */
function waitForTerminal(
  trading: TradingClient,
  oid: number,
  initial: Order,
  timeoutMs: number
): Promise<Order> {
  return waitForTerminalOrPriceMove(trading, oid, initial, timeoutMs).then((r) => r.order);
}

/**
 * Like waitForTerminal, but can also end the wait early when the book's touch
 * price moves away from where our order is resting (checked every 500ms via
 * `touchMoved`). Rationale: while our price IS the touch, cancelling only
 * resets queue position for nothing - but once price moves away, the order is
 * stranded and should be re-priced immediately.
 */
function waitForTerminalOrPriceMove(
  trading: TradingClient,
  oid: number,
  initial: Order,
  timeoutMs: number,
  touchMoved?: () => boolean
): Promise<{ order: Order; priceMoved: boolean }> {
  return new Promise((resolve) => {
    let latest = initial;
    if (TERMINAL_STATUSES.has(initial.st)) {
      resolve({ order: initial, priceMoved: false });
      return;
    }

    const onOrder = (order: Order) => {
      if (order.oid !== oid) return;
      latest = order;
      if (TERMINAL_STATUSES.has(order.st)) {
        cleanup();
        resolve({ order: latest, priceMoved: false });
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ order: latest, priceMoved: false });
    }, timeoutMs);
    const poller = touchMoved
      ? setInterval(() => {
          if (touchMoved()) {
            cleanup();
            resolve({ order: latest, priceMoved: true });
          }
        }, 500)
      : undefined;
    function cleanup() {
      clearTimeout(timer);
      if (poller) clearInterval(poller);
      trading.off("order", onOrder);
    }
    trading.on("order", onOrder);
  });
}

export interface ExecutionTrace {
  makerOrder?: Order; // last maker attempt (across all chase rounds)
  cancelOrder?: Order; // last cancel issued against a chase attempt
  takerOrder?: Order; // set only if the taker fallback fired
  chaseAttempts: number; // how many maker rounds were tried
  filledSize: number; // scaled, cumulative
  requestedSize: number; // scaled
}

interface ChaseParams {
  trading: TradingClient;
  marketData: MarketDataClient;
  market: Market;
  t: OrderType;
  accountId: number;
  size: number; // scaled
  isBuySide: boolean; // true -> rest at bid (buying); false -> rest at ask (selling)
  lvHundredths: number;
  positionId?: number; // sets `lp`, for closes
  makerTimeoutMs: number;
  chaseAttempts: number;
  chaseRetryBackoffMs: number;
  takerFallbackEnabled: boolean;
  maxTakerSlippageBps: number;
  expiryBlocks: number;
  chaseAbortDriftBps: number; // 0 = disabled
  chaseAbortConfirmAttempts: number;
}

/**
 * Shared execution primitive for both open and close: repeatedly posts a
 * post-only order at the current touch, and on timeout or an outright
 * CrossesBook rejection, cancels/retries at the *new* touch rather than
 * immediately taking - only falling back to a taker (IOC) order once the
 * chase attempts are exhausted (or never, if takerFallbackEnabled is false).
 * This is the main lever for raising the maker-fill ratio and cutting the
 * blended fee rate, since taker (6.9bps) is ~7.7x maker (0.9bps).
 *
 * Order traces alone are NOT trusted for fill accounting: a fill can land
 * during the cancel race (or arrive with no status update at all) without the
 * trace seeing it. Every attempt cross-checks the authoritative position cache
 * - for opens, a position appearing means we're filled; for closes, the
 * position disappearing means we're done.
 */
async function chaseThenMaybeTaker(cfg: ChaseParams): Promise<ExecutionTrace> {
  const trace: ExecutionTrace = { filledSize: 0, requestedSize: cfg.size, chaseAttempts: 0 };
  const isOpenLeg = cfg.positionId == null;
  let remaining = cfg.size;

  // Authoritative check against the position cache. Returns true when the leg's
  // goal is already achieved regardless of what the order traces reported.
  const legDone = (): boolean => {
    const pos = cfg.trading.findOpenPositionForMarket(cfg.market.id);
    if (isOpenLeg && pos) {
      trace.filledSize = Math.max(trace.filledSize, pos.s);
      remaining = 0;
      return true;
    }
    if (!isOpenLeg && !pos) {
      trace.filledSize = cfg.size;
      remaining = 0;
      return true;
    }
    return false;
  };

  // Chase-abort tracking: the trend guard only checks before the FIRST attempt -
  // this catches a chase that keeps getting re-priced against us attempt after
  // attempt (a live trend), bailing out early instead of paying an increasing
  // adverse price all the way to chaseAttempts. Requires several consecutive
  // adverse reprices (not just one) so a single noisy tick doesn't trigger it.
  let chaseStartPrice: number | undefined;
  let lastTouchPrice: number | undefined;
  let consecutiveAdverseMoves = 0;

  // For offline chase-tuning analysis (see eventLog.ts) - which attempt number
  // fills happen on, what gets rejected and why, book context at each post.
  const logAttempt = (
    attempt: number | "taker_fallback",
    status: string,
    filledSize: number,
    requestedSize: number,
    extra?: Record<string, unknown>
  ) => {
    logEvent("order_attempt", {
      marketId: cfg.market.id,
      leg: isOpenLeg ? "open" : "close",
      side: cfg.isBuySide ? "buy" : "sell",
      attempt,
      status,
      filledSize,
      requestedSize,
      ...extra,
    });
  };

  for (let attempt = 1; attempt <= cfg.chaseAttempts && remaining > 0; attempt++) {
    trace.chaseAttempts = attempt;
    if (legDone()) return trace;

    const bestBid = cfg.marketData.getBestBid();
    const bestAsk = cfg.marketData.getBestAsk();
    if (bestBid == null || bestAsk == null) break; // no book data - fall through to taker/give-up below

    const priceScaled = cfg.isBuySide ? bestBid : bestAsk;
    if (chaseStartPrice == null) chaseStartPrice = priceScaled;

    if (lastTouchPrice != null) {
      const movedAdverse = cfg.isBuySide ? priceScaled > lastTouchPrice : priceScaled < lastTouchPrice;
      consecutiveAdverseMoves = movedAdverse ? consecutiveAdverseMoves + 1 : 0;
    }
    lastTouchPrice = priceScaled;

    if (cfg.chaseAbortDriftBps > 0 && consecutiveAdverseMoves >= cfg.chaseAbortConfirmAttempts) {
      const driftBps = Math.abs(((priceScaled - chaseStartPrice) / chaseStartPrice) * 10000);
      if (driftBps >= cfg.chaseAbortDriftBps) {
        console.warn(
          `[orderEngine] aborting chase after ${attempt - 1} attempt(s) - price moved ${driftBps.toFixed(2)}bps ` +
            `against us over ${consecutiveAdverseMoves} consecutive reprices (>= ${cfg.chaseAbortDriftBps}bps threshold)`
        );
        logEvent("chase_abort", {
          marketId: cfg.market.id,
          leg: isOpenLeg ? "open" : "close",
          attempt,
          driftBps,
          thresholdBps: cfg.chaseAbortDriftBps,
          consecutiveAdverseMoves,
        });
        break;
      }
    }

    const requestedThisAttempt = remaining; // snapshot - `remaining` mutates once this attempt fills
    const request: Omit<OrderRequest, "mt" | "rq"> = {
      mkt: cfg.market.id,
      acc: cfg.accountId,
      t: cfg.t,
      p: priceScaled,
      s: remaining,
      fl: OrderFlags.PostOnly,
      lv: cfg.lvHundredths,
      lb: cfg.trading.getCurrentBlock() + cfg.expiryBlocks,
      ...(cfg.positionId != null ? { lp: cfg.positionId } : {}),
    };

    let makerResult: Order | undefined;
    try {
      makerResult = await cfg.trading.placeOrder(request);
    } catch (err) {
      // No status at all (silently dropped or update lost). By the time placeOrder
      // times out the order's lb (~15 blocks) has long expired, so it can no longer
      // fill - but it MAY have filled silently before expiring. The legDone() check
      // at the top of the next iteration (or below, after the loop) catches that.
      console.warn(`[orderEngine] no status for attempt ${attempt} (${(err as Error).message}) - re-checking state`);
      logAttempt(attempt, "no_status", 0, requestedThisAttempt, {
        error: (err as Error).message,
        priceScaled,
        bestBidScaled: bestBid,
        bestAskScaled: bestAsk,
      });
      await sleep(cfg.chaseRetryBackoffMs);
      continue;
    }
    trace.makerOrder = makerResult;

    if (makerResult.st === OrderStatus.Failed) {
      // e.g. sr: CrossesBook - didn't rest at all, no fill to account for. Re-price and retry quickly.
      logAttempt(attempt, "rejected", 0, requestedThisAttempt, {
        rejectReason: rejectReasonText(makerResult.sr),
        priceScaled,
        bestBidScaled: bestBid,
        bestAskScaled: bestAsk,
      });
      if (attempt < cfg.chaseAttempts) await sleep(cfg.chaseRetryBackoffMs);
      continue;
    }

    // Wait out the order's life, but bail early the moment the touch moves away
    // from our resting price - a stranded order should be re-priced immediately,
    // while an order still AT the touch shouldn't be cancelled (it would only
    // reset our queue position for nothing).
    const touchMoved = () => {
      const touch = cfg.isBuySide ? cfg.marketData.getBestBid() : cfg.marketData.getBestAsk();
      return touch != null && touch !== priceScaled;
    };
    const { order: settled, priceMoved } = await waitForTerminalOrPriceMove(
      cfg.trading,
      makerResult.oid,
      makerResult,
      cfg.makerTimeoutMs,
      touchMoved
    );
    trace.makerOrder = settled;
    trace.filledSize += settled.fs;
    remaining -= settled.fs;

    logAttempt(attempt, OrderStatus[settled.st] ?? String(settled.st), settled.fs, requestedThisAttempt, {
      priceScaled,
      bestBidScaled: bestBid,
      bestAskScaled: bestAsk,
      priceMoved,
      rejectReason: settled.st === OrderStatus.Failed ? rejectReasonText(settled.sr) : undefined,
    });

    if (remaining <= 0) break;

    if (priceMoved || (settled.st !== OrderStatus.Canceled && settled.st !== OrderStatus.Failed && settled.st !== OrderStatus.Expired)) {
      // Stranded (price moved) or still resting past its wait - cancel before re-pricing.
      // An Expired order is already off the book; no cancel needed, just repost.
      try {
        trace.cancelOrder = await cfg.trading.cancelOrder(cfg.market.id, settled.oid, cfg.expiryBlocks);
      } catch {
        // Order may have filled/expired between our timeout check and the cancel racing in - legDone() re-checks.
      }
    }
  }

  if (legDone()) return trace;

  if (remaining > 0 && cfg.takerFallbackEnabled) {
    const accountId = cfg.trading.getAccountId()!;
    const requestedTaker = remaining;
    try {
      trace.takerOrder = await cfg.trading.placeOrder({
        mkt: cfg.market.id,
        acc: accountId,
        t: cfg.t,
        p: 0, // market
        s: remaining,
        ms: cfg.maxTakerSlippageBps,
        fl: OrderFlags.ImmediateOrCancel,
        lv: cfg.lvHundredths,
        lb: cfg.trading.getCurrentBlock() + cfg.expiryBlocks,
        ...(cfg.positionId != null ? { lp: cfg.positionId } : {}),
      });
      trace.filledSize += trace.takerOrder.fs;
      logAttempt(
        "taker_fallback",
        OrderStatus[trace.takerOrder.st] ?? String(trace.takerOrder.st),
        trace.takerOrder.fs,
        requestedTaker
      );
    } catch (err) {
      console.warn(`[orderEngine] no status for taker fallback (${(err as Error).message}) - re-checking state`);
      logAttempt("taker_fallback", "no_status", 0, requestedTaker, { error: (err as Error).message });
      legDone();
    }
  }

  return trace;
}

export interface OpenParams {
  trading: TradingClient;
  marketData: MarketDataClient;
  market: Market;
  side: "long" | "short";
  notionalUsd: number;
  leverage?: number;
  makerTimeoutMs?: number;
  chaseAttempts?: number;
  chaseRetryBackoffMs?: number;
  takerFallbackEnabled?: boolean;
  maxTakerSlippageBps?: number;
  expiryBlocks?: number;
  chaseAbortDriftBps?: number;
  chaseAbortConfirmAttempts?: number;
}

/**
 * Maker-chase open: mirrors the docs' OrderRequest flag semantics (PostOnly=1,
 * ImmediateOrCancel=4) and the ms (max slippage bps) field for the taker leg's
 * threshold-price protection. See chaseThenMaybeTaker for the chase logic.
 */
export async function openMakerThenTaker(params: OpenParams): Promise<ExecutionTrace> {
  const {
    trading,
    marketData,
    market,
    side,
    notionalUsd,
    leverage = config.leverage,
    makerTimeoutMs = config.makerTimeoutMs,
    chaseAttempts = config.makerChaseAttempts,
    chaseRetryBackoffMs = config.chaseRetryBackoffMs,
    takerFallbackEnabled = config.openTakerFallback,
    maxTakerSlippageBps = config.maxTakerSlippageBps,
    expiryBlocks = config.orderExpiryBlocks,
    chaseAbortDriftBps = config.chaseAbortDriftBps,
    chaseAbortConfirmAttempts = config.chaseAbortConfirmAttempts,
  } = params;

  const accountId = trading.getAccountId();
  if (accountId == null) throw new Error("Trading client not authenticated yet");
  if (trading.getCurrentBlock() === 0) {
    throw new Error("No heartbeat received yet - current block unknown, refusing to place an order with a bogus expiry");
  }

  const bestBid = marketData.getBestBid();
  const bestAsk = marketData.getBestAsk();
  if (bestBid == null || bestAsk == null) throw new Error("No order book data yet");

  const { price_decimals, size_decimals } = market.config;
  const isLong = side === "long";
  const effectiveLeverage = clampLeverage(leverage, market);
  const effectiveExpiryBlocks = clampExpiryBlocks(expiryBlocks, market);
  const initialPriceScaled = isLong ? bestBid : bestAsk;
  const initialPrice = fromScaled(initialPriceScaled, price_decimals);
  const requestedSize = toScaled(notionalUsd / initialPrice, size_decimals);
  // A notional too small for the market's size granularity rounds to 0, and a
  // zero/sub-minimum order is rejected on every chase attempt - which the retry
  // loop treats as ordinary churn, so the bot would spin forever placing orders
  // that can never fill (no throw, no exit, just cycle_skipped in a loop). The
  // cost ladder in bot.ts clamps its floor above min_posting_amount, so reaching
  // this means a misconfiguration; fail loudly rather than silently no-op.
  const minPostingSize = Number(market.config.min_posting_amount ?? 0) || 0;
  if (requestedSize <= 0 || requestedSize < minPostingSize) {
    throw new Error(
      `notional $${notionalUsd} is too small for market ${market.id}: scaled size ${requestedSize} ` +
        `(price ${initialPrice}, size_decimals ${size_decimals}) is below min_posting_amount ${minPostingSize}`
    );
  }
  const t = isLong ? OrderType.OpenLong : OrderType.OpenShort;

  return chaseThenMaybeTaker({
    trading,
    marketData,
    market,
    t,
    accountId,
    size: requestedSize,
    isBuySide: isLong, // opening long = buying = rest at bid
    lvHundredths: effectiveLeverage * 100,
    makerTimeoutMs,
    chaseAttempts,
    chaseRetryBackoffMs,
    takerFallbackEnabled,
    maxTakerSlippageBps,
    expiryBlocks: effectiveExpiryBlocks,
    chaseAbortDriftBps,
    chaseAbortConfirmAttempts,
  });
}

export interface CloseParams {
  trading: TradingClient;
  marketData: MarketDataClient;
  market: Market;
  positionId: number;
  isLong: boolean;
  size: number; // scaled, full position size to close
  makerFirst?: boolean;
  makerTimeoutMs?: number;
  chaseAttempts?: number;
  chaseRetryBackoffMs?: number;
  maxTakerSlippageBps?: number;
  expiryBlocks?: number;
  chaseAbortDriftBps?: number;
  chaseAbortConfirmAttempts?: number;
}

/**
 * Reduce-only close, keyed to a specific position via `lp`. Closes are always
 * fee-free on Perpl regardless of maker/taker, so the default (makerFirst=false)
 * closes instantly via IOC market: the only cost is the half-spread (~0.1bps on
 * SOL at our size), and it ends the position's market risk immediately. Set
 * makerFirst=true (CLOSE_MAKER_FIRST env) to maker-chase the close instead.
 */
export async function closeMakerThenTaker(params: CloseParams): Promise<ExecutionTrace> {
  const {
    trading,
    marketData,
    market,
    positionId,
    isLong,
    size,
    makerFirst = config.closeMakerFirst,
    makerTimeoutMs = config.makerTimeoutMs,
    chaseAttempts = config.makerChaseAttempts,
    chaseRetryBackoffMs = config.chaseRetryBackoffMs,
    maxTakerSlippageBps = config.maxTakerSlippageBps,
    expiryBlocks = config.orderExpiryBlocks,
    chaseAbortDriftBps = config.chaseAbortDriftBps,
    chaseAbortConfirmAttempts = config.chaseAbortConfirmAttempts,
  } = params;

  const accountId = trading.getAccountId();
  if (accountId == null) throw new Error("Trading client not authenticated yet");
  if (trading.getCurrentBlock() === 0) {
    throw new Error("No heartbeat received yet - current block unknown, refusing to place an order with a bogus expiry");
  }

  const bestBid = marketData.getBestBid();
  const bestAsk = marketData.getBestAsk();
  if (bestBid == null || bestAsk == null) throw new Error("No order book data yet");

  const t = isLong ? OrderType.CloseLong : OrderType.CloseShort;
  const effectiveExpiryBlocks = clampExpiryBlocks(expiryBlocks, market);

  if (!makerFirst) {
    // Instant IOC market close with slippage cap. Taker close is free; a maker
    // chase here saves no fees and only prolongs exposure.
    const trace: ExecutionTrace = { filledSize: 0, requestedSize: size, chaseAttempts: 0 };
    trace.takerOrder = await trading.placeOrder({
      mkt: market.id,
      acc: accountId,
      t,
      p: 0, // market
      s: size,
      lp: positionId,
      ms: maxTakerSlippageBps,
      fl: OrderFlags.ImmediateOrCancel,
      lv: 0,
      lb: trading.getCurrentBlock() + effectiveExpiryBlocks,
    });
    trace.filledSize = trace.takerOrder.fs;
    return trace;
  }

  return chaseThenMaybeTaker({
    trading,
    marketData,
    market,
    t,
    accountId,
    size,
    isBuySide: !isLong, // closing a short = buying = rest at bid; closing a long = selling = rest at ask
    lvHundredths: 0,
    positionId,
    makerTimeoutMs,
    chaseAttempts,
    chaseRetryBackoffMs,
    takerFallbackEnabled: true, // when maker-chasing a close, always finish the job with taker - it's free anyway
    maxTakerSlippageBps,
    expiryBlocks: effectiveExpiryBlocks,
    chaseAbortDriftBps,
    chaseAbortConfirmAttempts,
  });
}

/**
 * Hard-timeout safety backstop: if a position is still open after `hardTimeoutMs`
 * from when this watchdog was armed, force an IOC market close for its full
 * remaining size, ignoring the maker-first pattern entirely.
 */
export function armHardTimeoutForceClose(
  trading: TradingClient,
  market: Market,
  positionId: number,
  isLong: boolean,
  size: number,
  hardTimeoutMs: number = config.hardTimeoutMs
): { cancel: () => void } {
  let done = false;
  const timer = setTimeout(async () => {
    if (done) return;
    done = true;
    // Firing at all (regardless of outcome) means the normal close path didn't
    // finish within hardTimeoutMs - worth flagging even on success, since a
    // healthy run should rarely if ever need this backstop.
    logEvent("watchdog_force_close", { marketId: market.id, positionId, size, phase: "fired", hardTimeoutMs });
    const accountId = trading.getAccountId();
    if (accountId == null) {
      logEvent("watchdog_force_close", { marketId: market.id, positionId, outcome: "failed", error: "no accountId" });
      return;
    }
    const t = isLong ? OrderType.CloseLong : OrderType.CloseShort;
    try {
      await trading.placeOrder({
        mkt: market.id,
        acc: accountId,
        t,
        p: 0,
        s: size,
        lp: positionId,
        ms: config.maxTakerSlippageBps * 4, // wider band - this is a safety exit, not a cost-optimized one
        fl: OrderFlags.ImmediateOrCancel,
        lv: 0,
        lb: trading.getCurrentBlock() + clampExpiryBlocks(config.orderExpiryBlocks, market),
      });
      logEvent("watchdog_force_close", { marketId: market.id, positionId, size, outcome: "success" });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Hard-timeout force-close failed for position ${positionId}:`, err);
      logEvent("watchdog_force_close", { marketId: market.id, positionId, size, outcome: "failed", error: (err as Error).message });
    }
  }, hardTimeoutMs);

  return {
    cancel: () => {
      done = true;
      clearTimeout(timer);
    },
  };
}

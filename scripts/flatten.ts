// Stop-safety flatten: leaves the account with NOTHING working and NOTHING open.
//
//   npx tsx scripts/flatten.ts
//
// Unlike close-now.ts (which only closes a position on config.marketId), this:
//   1. cancels every live/resting order on the account, on every market,
//   2. closes every open position, on every market (IOC market, reduce-only),
//   3. re-checks after a settle delay and repeats - a resting order can fill in
//      the instant you cancel it, creating a brand-new position after step 2,
//   4. exits non-zero (and pushes an ntfy alert) if anything is still live, so a
//      scheduled stop screams instead of silently leaving risk on overnight.
//
// This is what the scheduled window's stop step runs after `pm2 stop`, and what
// stop-bot.ps1 runs after killing the process tree.
import { config } from "../src/config.js";
import { sendNtfyMessage } from "../src/ntfyNotifier.js";
import { TradingClient } from "../src/tradingClient.js";
import { OrderFlags, OrderStatus, OrderType, type Order, type Position, type Wallet } from "../src/types.js";

/** Statuses that mean the order is still working on the exchange. */
const LIVE_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.Pending,
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
  OrderStatus.Untriggered,
  OrderStatus.Triggered,
]);

const MAX_ROUNDS = 6;
const SETTLE_MS = 3000; // let cancels/closes land and their updates come back
const OVERALL_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const trading = new TradingClient();
const liveOrders = new Map<number, Order>();
const positions = new Map<number, Position>();
let accountId: number | undefined;
let gotHeartbeat = false;
let gotPositions = false;
let cancelled = 0; // counted for the "what did the stop have to clean up" notification
let closed = 0;

// Hard ceiling: never let a scheduled stop hang forever holding the cron slot.
const overallTimer = setTimeout(async () => {
  await fail("timed out (180s) before the account could be confirmed flat");
}, OVERALL_TIMEOUT_MS);

// A throw inside a WS event handler would otherwise kill the process silently -
// for a stop-safety script, dying quietly is the one unacceptable failure mode.
process.on("uncaughtException", (err) => void fail(`uncaught exception: ${(err as Error).message}`));
process.on("unhandledRejection", (err) => void fail(`unhandled rejection: ${String(err)}`));

trading.on("error", (err) => console.error("[trading] error:", err));
trading.once("wallet", (_wallet: Wallet) => {
  // Respects PERPL_ACCOUNT_ID pinning (applied synchronously before this fires).
  accountId = trading.getAccountId();
});
trading.once("heartbeat", () => {
  gotHeartbeat = true;
});
trading.on("orders", (orders: Order[]) => {
  for (const o of orders ?? []) {
    // `r` is the exchange's own "remove from open orders" flag - trust it over status.
    if (o.r === true || !LIVE_ORDER_STATUSES.has(o.st)) liveOrders.delete(o.oid);
    else liveOrders.set(o.oid, o);
  }
});
trading.on("positions", (updated: Position[]) => {
  gotPositions = true;
  for (const p of updated ?? []) positions.set(p.pid, p);
});

function openPositions(): Position[] {
  return [...positions.values()].filter((p) => p.st === 1 /* Open */);
}

async function fail(reason: string): Promise<never> {
  clearTimeout(overallTimer);
  const orders = [...liveOrders.values()];
  const open = openPositions();
  const detail =
    `${reason}\n` +
    `Live orders: ${orders.length}${orders.length ? ` (oid ${orders.map((o) => o.oid).join(", ")})` : ""}\n` +
    `Open positions: ${open.length}${open.length ? ` (pid ${open.map((p) => p.pid).join(", ")})` : ""}\n` +
    `Close them by hand: npx tsx scripts/check-live-state.ts / scripts/flatten.ts`;
  console.error(`[flatten] FAILED - ${detail}`);
  await sendNtfyMessage("FLATTEN FAILED", detail);
  trading.disconnect();
  process.exit(1);
}

/** Cancels one working order; a cancel that races a fill/expiry is not an error. */
async function cancelOne(order: Order): Promise<void> {
  console.log(`[flatten] cancelling oid=${order.oid} mkt=${order.mkt} type=${order.t} size=${order.os}`);
  cancelled++;
  try {
    await trading.cancelOrder(order.mkt, order.oid);
  } catch (err) {
    console.warn(`[flatten] cancel oid=${order.oid} got no clean status (${(err as Error).message}) - re-checking`);
  }
}

/** Closes one open position with a wide-band IOC market order (reduce-only via lp). */
async function closeOne(position: Position): Promise<void> {
  if (accountId == null) await fail("no account id - refusing to guess which account to trade");
  console.log(
    `[flatten] closing pid=${position.pid} mkt=${position.mkt} ` +
      `side=${position.sd === 1 ? "long" : "short"} size=${position.s}`
  );
  closed++;
  try {
    await trading.placeOrder({
      mkt: position.mkt,
      acc: accountId!,
      t: position.sd === 1 ? OrderType.CloseLong : OrderType.CloseShort,
      p: 0, // market
      s: position.s,
      lp: position.pid,
      ms: config.maxTakerSlippageBps * 4, // wide band - urgent exit, not cost-optimized
      fl: OrderFlags.ImmediateOrCancel,
      lv: 0,
      lb: trading.getCurrentBlock() + 15,
    });
  } catch (err) {
    console.warn(`[flatten] close pid=${position.pid} got no clean status (${(err as Error).message}) - re-checking`);
  }
}

async function run(): Promise<void> {
  // Snapshots land right after auth; heartbeats can lag, and without a real
  // currentBlock every order gets an already-expired lb and is silently dropped.
  const deadline = Date.now() + 60_000;
  while ((!gotHeartbeat || !gotPositions || accountId == null) && Date.now() < deadline) await sleep(250);
  if (!gotHeartbeat || accountId == null) await fail("no heartbeat/account id within 60s");
  // The orders snapshot has no "ready" signal of its own - give it a beat to arrive.
  await sleep(2000);

  console.log(
    `[flatten] account=${accountId} block=${trading.getCurrentBlock()} ` +
      `live orders=${liveOrders.size} open positions=${openPositions().length}`
  );

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const orders = [...liveOrders.values()];
    const open = openPositions();
    if (orders.length === 0 && open.length === 0) {
      // Clean once is not clean: a fill from the cancels above can still be in
      // flight. Wait one settle window and require a second clean look.
      await sleep(SETTLE_MS);
      if (liveOrders.size === 0 && openPositions().length === 0) {
        clearTimeout(overallTimer);
        console.log("[flatten] account is flat: no working orders, no open positions.");
        await sendNtfyMessage(
          "Flat",
          `Account ${accountId} verified flat: no working orders, no open positions.\n` +
            (cancelled + closed > 0
              ? `Cleaned up on the way out: ${cancelled} order(s) cancelled, ${closed} position(s) closed.`
              : "Nothing was left behind.")
        );
        trading.disconnect();
        process.exit(0);
      }
      continue;
    }

    console.log(`[flatten] round ${round}/${MAX_ROUNDS}: ${orders.length} order(s), ${open.length} position(s)`);
    // Cancel first, then close: cancelling removes the source of new positions,
    // so the close in this same round is less likely to be immediately undone.
    for (const o of orders) await cancelOne(o);
    for (const p of open) await closeOne(p);
    await sleep(SETTLE_MS);
  }

  await fail(`still not flat after ${MAX_ROUNDS} rounds`);
}

trading.connect();
run().catch(async (err) => {
  await fail(`unexpected error: ${(err as Error).message}`);
});

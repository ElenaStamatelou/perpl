// Emergency: closes whatever is currently open on config.marketId via IOC market
// order (reduce-only, tied to the specific position id). Run this yourself:
//   npx tsx scripts/close-now.ts
import { config } from "../src/config.js";
import { TradingClient } from "../src/tradingClient.js";
import { OrderFlags, OrderType, type Position, type Wallet } from "../src/types.js";

const trading = new TradingClient();
// Heartbeats on the trading WS can take a while to start arriving - wait generously.
const timeout = setTimeout(() => {
  console.error("Timed out waiting for snapshots/heartbeat (45s)");
  process.exit(1);
}, 45000);

let accountId: number | undefined;
let gotPositions: Position[] | undefined;
let gotHeartbeat = false;

trading.once("wallet", (_wallet: Wallet) => {
  // Respects PERPL_ACCOUNT_ID pinning (set synchronously before this event fires).
  accountId = trading.getAccountId();
});

trading.once("heartbeat", () => {
  gotHeartbeat = true;
  maybeRun();
});

trading.once("positions", (positions: Position[]) => {
  gotPositions = positions;
  maybeRun();
});

async function maybeRun() {
  // Need a real currentBlock (from a heartbeat) before computing a valid lb,
  // same requirement as bot.ts/orderEngine.ts - otherwise the order is
  // rejected as "last exec block already expired".
  if (!gotHeartbeat || !gotPositions) return;
  const positions = gotPositions;
  clearTimeout(timeout);
  const open = positions.find((p) => p.mkt === config.marketId && p.st === 1);
  if (!open) {
    console.log("Nothing open on this market. Nothing to do.");
    trading.disconnect();
    process.exit(0);
  }
  if (accountId == null) {
    console.error("No account id yet - aborting, do not want to guess.");
    trading.disconnect();
    process.exit(1);
  }

  console.log(`Closing pid=${open.pid} side=${open.sd === 1 ? "long" : "short"} size=${open.s} ...`);
  const t = open.sd === 1 ? OrderType.CloseLong : OrderType.CloseShort;

  try {
    const result = await trading.placeOrder({
      mkt: config.marketId,
      acc: accountId,
      t,
      p: 0, // market
      s: open.s,
      lp: open.pid,
      ms: config.maxTakerSlippageBps * 4, // wide band - this is an urgent exit, not cost-optimized
      fl: OrderFlags.ImmediateOrCancel,
      lv: 0,
      lb: trading.getCurrentBlock() + 15,
    });
    console.log("Close result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Close failed:", err);
    process.exitCode = 1;
  }
  trading.disconnect();
  process.exit();
}

trading.connect();

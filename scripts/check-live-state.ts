// Read-only: authoritative "what's open right now" straight from the trading
// WebSocket's PositionsSnapshot (mt:26), sent immediately after auth. No orders placed.
import { TradingClient } from "../src/tradingClient.js";
import type { Position, Wallet } from "../src/types.js";

const trading = new TradingClient();
const timeout = setTimeout(() => {
  console.error("Timed out waiting for snapshots");
  process.exit(1);
}, 15000);

let gotWallet = false;
let gotPositions = false;

function maybeExit() {
  if (gotWallet && gotPositions) {
    clearTimeout(timeout);
    trading.disconnect();
    process.exit(0);
  }
}

trading.once("wallet", (wallet: Wallet) => {
  gotWallet = true;
  for (const acc of wallet.as ?? []) {
    console.log(`Account ${acc.id}: balance=${acc.b} locked=${acc.lb} frozen=${acc.fr}`);
  }
  maybeExit();
});

trading.once("positions", (positions: Position[]) => {
  gotPositions = true;
  console.log(`\nPositionsSnapshot: ${positions.length} entries`);
  for (const p of positions) {
    console.log(
      `  pid=${p.pid} status=${p.st}${p.st === 1 ? " <-- OPEN RIGHT NOW" : ""} side=${p.sd === 1 ? "long" : "short"} size=${p.s} entry=${p.ep} oid=${p.oid}`
    );
  }
  if (positions.length === 0) console.log("  (empty - nothing open)");
  maybeExit();
});

trading.connect();

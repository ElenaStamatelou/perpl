// Read-only sanity check: authenticate the trading WebSocket and print back
// the account snapshot. Places no orders. Exits after the first snapshot or
// a 15s timeout.
import { TradingClient } from "../src/tradingClient.js";
import { config } from "../src/config.js";
import type { Wallet } from "../src/types.js";

const trading = new TradingClient();

trading.on("error", (err) => console.error("[trading] error:", err));

const timeout = setTimeout(() => {
  console.error("Timed out waiting for authentication/snapshot (15s)");
  process.exit(1);
}, 15000);

trading.once("wallet", (wallet: Wallet) => {
  clearTimeout(timeout);
  console.log(`Network: ${config.network} (chain ${config.chainId})`);
  console.log(`Wallet address: ${wallet.addr}`);
  console.log(`Accounts:`);
  for (const acc of wallet.as ?? []) {
    console.log(
      `  id=${acc.id} balance=${acc.b} locked=${acc.lb} frozen=${acc.fr} lastForwardedRequestId=${acc.lfr}`
    );
  }
  console.log(`Fee level: ${wallet.fl}`);
  trading.disconnect();
  process.exit(0);
});

console.log(`Connecting to ${config.wsUrl}/ws/v1/trading ...`);
trading.connect();

// Read-only sanity check: authenticate the trading WebSocket and print back
// the account snapshot. Places no orders. Exits after the first snapshot or
// a 15s timeout.
import { TradingClient } from "../src/tradingClient.js";
import { config } from "../src/config.js";
import type { Wallet } from "../src/types.js";

// Amount fields (balance, locked) are decimal strings scaled 1e6 (AUSD, 6 decimals) -
// same convention as fee/pnl everywhere else (bot.ts:349, audit-run.ts, account-stats.ts).
// Printing them raw previously showed "balance=8858" for an account actually holding
// $0.008858 - looked like a healthy balance and was in fact almost empty.
const usd = (a: unknown) => Number(a ?? 0) / 1e6;
const money = (n: number) => `$${n.toFixed(2)}`;

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
      `  id=${acc.id} balance=${money(usd(acc.b))} locked=${money(usd(acc.lb))} frozen=${acc.fr} lastForwardedRequestId=${acc.lfr}`
    );
  }
  console.log(`Fee level: ${wallet.fl}`);
  trading.disconnect();
  process.exit(0);
});

console.log(`Connecting to ${config.wsUrl}/ws/v1/trading ...`);
trading.connect();

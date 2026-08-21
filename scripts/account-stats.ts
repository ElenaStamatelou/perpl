// Read-only: prints the platform's OWN lifetime account figures from the
// WalletSnapshot's AccountStats (mt:19 `sts`) - total deposits, total
// withdrawals, total volume, total realized PNL, trade count, win rate.
//
//   npx tsx scripts/account-stats.ts
//
// These are the exchange's authoritative numbers covering the account's entire
// life, including any period before the bot's local logs start. Places no
// orders and changes nothing.
import { TradingClient } from "../src/tradingClient.js";
import type { Wallet } from "../src/types.js";

const trading = new TradingClient();
const timeout = setTimeout(() => {
  console.error("Timed out waiting for the wallet snapshot (30s)");
  process.exit(1);
}, 30000);

const usd = (a: unknown) => Number(a ?? 0) / 1e6; // AUSD, 6 decimals
const money = (n: number) => `$${n.toFixed(2)}`;

trading.once("wallet", (wallet: Wallet) => {
  clearTimeout(timeout);
  console.log(`Wallet: ${wallet.addr}`);
  console.log(`Fee level: ${wallet.fl}\n`);

  for (const acc of wallet.as ?? []) {
    console.log(`Account ${acc.id}: balance=${money(usd(acc.b))} locked=${money(usd(acc.lb))}`);
  }

  const stats = wallet.sts ?? [];
  if (stats.length === 0) {
    console.log("\nNo AccountStats in this snapshot.");
    trading.disconnect();
    process.exit(0);
  }

  for (const s of stats) {
    const deposits = usd(s.td);
    const withdrawals = usd(s.tw);
    const realizedPnl = usd(s.trp);
    const volume = usd(s.tv);
    const balance = usd((wallet.as ?? []).find((a) => a.id === s.id)?.b ?? 0);
    // What the account is actually down: everything put in, minus what came
    // back out, versus what is left sitting there now.
    const netIn = deposits - withdrawals;
    const netChange = balance - netIn;
    const pct = netIn > 0 ? (netChange / netIn) * 100 : 0;

    console.log(`\n${"=".repeat(56)}`);
    console.log(`ACCOUNT ${s.id} - platform lifetime figures`);
    console.log("=".repeat(56));
    console.log(`  Total deposits            ${money(deposits).padStart(14)}`);
    console.log(`  Total withdrawals         ${money(withdrawals).padStart(14)}`);
    console.log(`  Net deposited (in - out)  ${money(netIn).padStart(14)}`);
    console.log(`  Current balance           ${money(balance).padStart(14)}`);
    console.log(`  ${"-".repeat(52)}`);
    console.log(`  Net change vs deposited   ${money(netChange).padStart(14)}  (${pct.toFixed(2)}%)`);
    console.log(`  ${"-".repeat(52)}`);
    console.log(`  Total realized PNL        ${money(realizedPnl).padStart(14)}   <- price movement only, EXCLUDES fees`);
    console.log(`  Total trading volume      ${money(volume).padStart(14)}`);
    console.log(`  Total trades              ${String(s.tt).padStart(14)}`);
    console.log(`  Win rate                  ${(s.wr / 100).toFixed(2).padStart(13)}%`);
    // Fees are not reported directly; back them out of the identity
    //   balance = netIn + realizedPnl - fees + rebates
    console.log(`  ${"-".repeat(52)}`);
    console.log(`  Implied fees - rebates    ${money(netIn + realizedPnl - balance).padStart(14)}   <- derived, not reported`);
  }

  trading.disconnect();
  process.exit(0);
});

trading.connect();

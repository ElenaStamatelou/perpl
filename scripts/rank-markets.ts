// Read-only: ranks markets by points_boost_bps so MARKET_ID can be picked to
// maximize points-weighted volume per dollar spent, not just low fees.
import { getContext } from "../src/restClient.js";

const ctx = await getContext();

const rows = ctx.markets.map((m) => {
  const mid = m.state.mid / 10 ** m.config.price_decimals;
  const oiUsd = (m.state.oi / 10 ** m.config.size_decimals) * mid;
  return {
    symbol: m.symbol || m.name, // symbol is blank for some markets (e.g. BTC, MON) - fall back to name
    boostBps: m.points_boost_bps,
    makerFeeBps: m.config.maker_fee / 100,
    takerFeeBps: m.config.taker_fee / 100,
    oiUsd,
    dailyVolUsd: Number(m.state.dva) / 1e6, // Amount fields are AUSD-denominated, 6 decimals
    isOpen: m.config.is_open,
  };
});
rows.sort((a, b) => b.boostBps - a.boostBps);

console.log(
  "symbol".padEnd(8) +
    "boost".padStart(8) +
    "makerFee".padStart(11) +
    "takerFee".padStart(11) +
    "openInterest$".padStart(18) +
    "dailyVol$".padStart(16) +
    "  open"
);
for (const r of rows) {
  console.log(
    r.symbol.padEnd(8) +
      `${r.boostBps}bps`.padStart(8) +
      `${r.makerFeeBps.toFixed(2)}bps`.padStart(11) +
      `${r.takerFeeBps.toFixed(2)}bps`.padStart(11) +
      `$${r.oiUsd.toFixed(0)}`.padStart(18) +
      `$${r.dailyVolUsd.toFixed(0)}`.padStart(16) +
      `  ${r.isOpen}`
  );
}

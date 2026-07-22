// Read-only: audits a run against the exchange's own fill records (ground truth).
// Usage: npx tsx scripts/audit-run.ts <sinceEpochMs>
import { getFills, getPositionHistory } from "../src/restClient.js";
import { getContext } from "../src/restClient.js";
import { LiquiditySide, OrderType, type Fill, type Position } from "../src/types.js";

const sinceMs = Number(process.argv[2]);
if (!sinceMs) throw new Error("Pass the run start time in epoch ms as the first argument");

const context = await getContext();

// Pull pages until we're past the cutoff (fills come newest-to-oldest).
const fills: Fill[] = [];
let page: string | undefined;
do {
  const res = await getFills(100, page);
  fills.push(...res.d);
  page = res.np;
  const oldest = res.d[res.d.length - 1];
  if (!oldest || (oldest.at.t ?? 0) < sinceMs) break;
} while (page);

const runFills = fills.filter((f) => (f.at.t ?? 0) >= sinceMs);

let volumeUsd = 0;
let feeUsd = 0;
let makerOpenSize = 0;
let takerOpenSize = 0;
let makerCloseSize = 0;
let takerCloseSize = 0;

for (const f of runFills) {
  const market = context.markets.find((m) => m.id === f.mkt);
  if (!market) continue;
  const price = (f.p ?? 0) / 10 ** market.config.price_decimals;
  const size = f.s / 10 ** market.config.size_decimals;
  volumeUsd += price * size;
  feeUsd += Number(f.f) / 1e6; // AUSD, 6 decimals
  const isOpen = f.t === OrderType.OpenLong || f.t === OrderType.OpenShort;
  if (isOpen) {
    if (f.l === LiquiditySide.Maker) makerOpenSize += f.s;
    else takerOpenSize += f.s;
  } else {
    if (f.l === LiquiditySide.Maker) makerCloseSize += f.s;
    else takerCloseSize += f.s;
  }
}

const openTotal = makerOpenSize + takerOpenSize;
const closeTotal = makerCloseSize + takerCloseSize;
const allTotal = openTotal + closeTotal;
const allMaker = makerOpenSize + makerCloseSize;

// Realized PnL from position history in the same window (newest-to-oldest; first
// occurrence per pid is its latest state, dpnl accumulates over the position's life).
const positions: Position[] = [];
let posPage: string | undefined;
do {
  const res = await getPositionHistory(50, posPage);
  positions.push(...res.d);
  posPage = res.np;
  const oldest = res.d[res.d.length - 1];
  if (!oldest || (oldest.at.t ?? 0) < sinceMs) break;
} while (posPage);

const latestPerPid = new Map<number, Position>();
for (const p of positions) {
  if ((p.at.t ?? 0) < sinceMs) continue;
  if (!latestPerPid.has(p.pid)) latestPerPid.set(p.pid, p);
}
let realizedPnlUsd = 0;
for (const p of latestPerPid.values()) {
  realizedPnlUsd += Number(p.dpnl ?? "0") / 1e6;
}

// Volume pace from the fill timestamp span.
const timestamps = runFills.map((f) => f.at.t ?? 0).filter((t) => t > 0);
const spanMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
const spanHours = spanMs / 3_600_000;
const volumePerHour = spanHours > 0 ? volumeUsd / spanHours : undefined;

const totalBurnUsd = feeUsd - realizedPnlUsd; // fees plus net trading loss (PnL negative -> adds to burn)

console.log(`Fills in this run: ${runFills.length}`);
console.log(`TRUE volume (exchange records): $${volumeUsd.toFixed(2)}`);
console.log(`TRUE fees paid: $${feeUsd.toFixed(4)}`);
console.log(`Realized PnL: $${realizedPnlUsd.toFixed(4)} (${latestPerPid.size} positions)`);
console.log(`All-in burn (fees - PnL): $${totalBurnUsd.toFixed(4)} = ${volumeUsd ? ((totalBurnUsd / volumeUsd) * 10000).toFixed(2) : "n/a"} bps = $${volumeUsd ? ((totalBurnUsd / volumeUsd) * 1e6).toFixed(0) : "n/a"}/1M`);
console.log(`Blended fee rate: ${volumeUsd ? ((feeUsd / volumeUsd) * 10000).toFixed(2) : "n/a"} bps`);
console.log(`Cost per $1M volume (fees only): $${volumeUsd ? ((feeUsd / volumeUsd) * 1e6).toFixed(0) : "n/a"}`);
console.log(
  `Run span: ${(spanMs / 60000).toFixed(1)} min -> volume pace: ${volumePerHour != null ? `$${volumePerHour.toFixed(0)}/hour` : "n/a"}`
);
console.log(`Maker ratio (all legs): ${allTotal ? ((allMaker / allTotal) * 100).toFixed(1) : 0}%`);
console.log(`  open leg:  maker=${openTotal ? ((makerOpenSize / openTotal) * 100).toFixed(1) : 0}% (fees apply here)`);
console.log(`  close leg: maker=${closeTotal ? ((makerCloseSize / closeTotal) * 100).toFixed(1) : 0}% (close is free either way)`);

// Read-only: summarizes a test run using both our own cycle log and the
// exchange's own fill/position records (as a cross-check). No orders placed.
import { readFileSync, existsSync } from "node:fs";
import { getFills, getPositionHistory } from "../src/restClient.js";
import { LiquiditySide, OrderType } from "../src/types.js";
import type { CycleSummary } from "../src/metrics.js";

const LOG_PATH = new URL("../logs/cycles.jsonl", import.meta.url);

console.log("=== From our own per-cycle log (logs/cycles.jsonl) ===");
if (existsSync(LOG_PATH)) {
  const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  const cycles: CycleSummary[] = lines.map((l) => JSON.parse(l));
  const totalVolume = cycles.reduce((s, c) => s + c.volumeUsd, 0);
  const avgBps = cycles.length ? cycles.reduce((s, c) => s + c.bpsBurned, 0) / cycles.length : 0;
  const avgMakerRatio = cycles.length ? cycles.reduce((s, c) => s + c.makerFillRatio, 0) / cycles.length : 0;
  const estimatedFeeUsd = cycles.reduce((s, c) => s + (c.bpsBurned / 10000) * c.volumeUsd, 0);
  console.log(`Cycles recorded: ${cycles.length}`);
  console.log(`Total volume: $${totalVolume.toFixed(2)}`);
  console.log(`Avg bps burned: ${avgBps.toFixed(2)}`);
  console.log(`Avg maker-fill ratio: ${(avgMakerRatio * 100).toFixed(1)}%`);
  console.log(`Estimated total fees (from bps burned): $${estimatedFeeUsd.toFixed(4)}`);
} else {
  console.log("No logs/cycles.jsonl yet.");
}

console.log("\n=== Cross-check against exchange records (REST) ===");
const fills = await getFills(100);
let openMakerSize = 0;
let openTakerSize = 0;
let totalFeeRaw = 0;
let totalNotionalRaw = 0;
for (const f of fills.d) {
  totalFeeRaw += Number(f.f);
  totalNotionalRaw += (f.p ?? 0) * f.s;
  const isOpen = f.t === OrderType.OpenLong || f.t === OrderType.OpenShort;
  if (isOpen) {
    if (f.l === LiquiditySide.Maker) openMakerSize += f.s;
    else if (f.l === LiquiditySide.Taker) openTakerSize += f.s;
  }
}
const openTotal = openMakerSize + openTakerSize;
console.log(`Total fills: ${fills.d.length}`);
console.log(`Total fees paid (all fills): $${(totalFeeRaw / 1e6).toFixed(4)}`);
console.log(
  `Open-leg maker/taker split: maker=${openTotal ? ((openMakerSize / openTotal) * 100).toFixed(1) : 0}% taker=${openTotal ? ((openTakerSize / openTotal) * 100).toFixed(1) : 0}%`
);

const positions = await getPositionHistory(100);
const uniquePids = new Map<number, (typeof positions.d)[number]>();
for (const p of positions.d) if (!uniquePids.has(p.pid)) uniquePids.set(p.pid, p);
let totalDpnl = 0;
let openCount = 0;
for (const p of uniquePids.values()) {
  totalDpnl += Number(p.dpnl ?? "0") / 1e6;
  if (p.st === 1) openCount++;
}
console.log(`Unique positions seen (last 100 records): ${uniquePids.size}`);
console.log(`Currently open positions: ${openCount}${openCount > 0 ? "  <-- CHECK THIS" : ""}`);
console.log(`Total realized PnL (all-time, from these records): $${totalDpnl.toFixed(4)}`);

// Offline replay of the cost ladder over a cycles.jsonl, using the same maths the
// bot runs live (cycleAllInCostUsd + costPerMillionUsd from src/metrics.ts). Answers
// "what would this ladder have done to the last N weeks" before risking money on it.
//
//   npx tsx scripts/replay-ladder.ts [logs/cycles.jsonl]
//
// Volume/cost are scaled linearly by the chosen notional, which assumes cost per $1M
// is independent of clip size - true for a $400 BTC clip (see NOTIONAL_USD in
// .env.example: the book swallows it without walking the touch), and the reason the
// ladder's saving comes from trading less when expensive, not from cheaper fills.
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { cycleAllInCostUsd, costPerMillionUsd } from "../src/metrics.js";
import type { CycleSummary } from "../src/metrics.js";

// Mirrors ladderNotionalUsd() in bot.ts, which can't be imported (bot.ts self-runs).
// A null reading (cold start / post-restart, no evidence yet) maps to the floor,
// not full - size has to earn its way up once real data backs it.
function ladder(costPerMillion: number | null, floorUsd: number): number {
  if (costPerMillion == null) return Math.min(floorUsd, config.notionalUsd);
  if (costPerMillion <= config.costLadderTier1UsdPerM) return config.notionalUsd;
  if (costPerMillion <= config.costLadderTier2UsdPerM) return Math.min(config.costLadderNotionalMid, config.notionalUsd);
  return Math.min(floorUsd, config.notionalUsd);
}

const path = process.argv[2] || "logs/cycles.jsonl";
const rows: CycleSummary[] = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CycleSummary)
  .filter((d) => d.volumeUsd && d.bpsBurned != null)
  .sort((a, b) => a.ts - b.ts);

console.log(
  `ladder: full=$${config.notionalUsd} mid=$${config.costLadderNotionalMid} floor=$${config.costLadderNotionalFloor} ` +
    `| tier1=$${config.costLadderTier1UsdPerM}/1M tier2=$${config.costLadderTier2UsdPerM}/1M over ${config.costLadderCycles} cycles`
);
console.log(`replaying ${rows.length} cycles from ${path}\n`);

let baseVol = 0;
let baseCost = 0;
let simVol = 0;
let simCost = 0;
let blind = 0;
let changes = 0;
let prev = config.notionalUsd;
const recent: Array<{ costUsd: number; volumeUsd: number }> = [];
const atRung = new Map<number, number>();

for (const d of rows) {
  const costUsd = cycleAllInCostUsd(d);
  baseVol += d.volumeUsd;
  baseCost += costUsd;

  const perMillion = costPerMillionUsd(recent, config.costLadderCycles);
  if (perMillion == null) blind++;
  const notional = ladder(perMillion, config.costLadderNotionalFloor);
  if (notional !== prev) {
    changes++;
    prev = notional;
  }
  atRung.set(notional, (atRung.get(notional) ?? 0) + 1);

  const scale = notional / config.notionalUsd;
  simVol += d.volumeUsd * scale;
  simCost += costUsd * scale;

  recent.push({ costUsd, volumeUsd: d.volumeUsd });
  const keep = Math.max(config.costLadderCycles, 1);
  if (recent.length > keep) recent.splice(0, recent.length - keep);
}

const m = (n: number) => n.toFixed(2);
console.log(`  flat $${config.notionalUsd}   : volume $${m(baseVol / 1e6)}M  cost $${m(baseCost)}  = $${m((baseCost / baseVol) * 1e6)}/1M`);
console.log(`  with ladder : volume $${m(simVol / 1e6)}M  cost $${m(simCost)}  = $${m((simCost / simVol) * 1e6)}/1M`);
console.log(
  `\n  volume kept ${((100 * simVol) / baseVol).toFixed(0)}%   ` +
    `burn saved ${(100 * (1 - simCost / baseCost)).toFixed(0)}% ($${m(baseCost - simCost)})   ` +
    `no-reading ${((100 * blind) / rows.length).toFixed(1)}%`
);
console.log(`  rung changes: ${changes} (one per ${(rows.length / changes).toFixed(0)} cycles)`);
for (const [notional, count] of [...atRung.entries()].sort((a, b) => b[0] - a[0])) {
  console.log(`    $${String(notional).padStart(3)} notional: ${((100 * count) / rows.length).toFixed(1)}% of cycles`);
}

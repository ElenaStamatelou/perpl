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
import { ladderNotionalUsd as ladder, ladderPoints } from "../src/costLadder.js";

const path = process.argv[2] || "logs/cycles.jsonl";
const rows: CycleSummary[] = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CycleSummary)
  .filter((d) => d.volumeUsd && d.bpsBurned != null)
  .sort((a, b) => a.ts - b.ts);

console.log(
  `ladder: ${ladderPoints()
    .map((p) => `$${p.costPerMillion}/1M->$${p.notionalUsd}`)
    .join(" ")} (piecewise linear) ` +
    `over ${config.costLadderCycles} cycles | notify step $${config.costLadderNotifyStepUsd}`
);
console.log(`replaying ${rows.length} cycles from ${path}\n`);

let baseVol = 0;
let baseCost = 0;
let simVol = 0;
let simCost = 0;
let blind = 0;
let notifyEvents = 0;
let lastPushed = config.notionalUsd;
const recent: Array<{ costUsd: number; volumeUsd: number }> = [];
const notionals: number[] = [];

for (const d of rows) {
  const costUsd = cycleAllInCostUsd(d);
  baseVol += d.volumeUsd;
  baseCost += costUsd;

  const perMillion = costPerMillionUsd(recent, config.costLadderCycles);
  if (perMillion == null) blind++;
  const notional = ladder(perMillion, config.costLadderNotionalFloor);
  // Mirrors bot.ts: a push fires immediately once the move since the last one
  // sent clears the step threshold - no wall-clock cooldown.
  if (perMillion != null && Math.abs(notional - lastPushed) >= config.costLadderNotifyStepUsd) {
    notifyEvents++;
    lastPushed = notional;
  }
  notionals.push(notional);

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
console.log(
  `  notify events: ${notifyEvents} (one per ${(rows.length / Math.max(notifyEvents, 1)).toFixed(0)} cycles; ` +
    `>= $${config.costLadderNotifyStepUsd} move)`
);

const sorted = [...notionals].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
const avg = notionals.reduce((s, n) => s + n, 0) / notionals.length;
console.log(
  `  notional distribution: min $${m(sorted[0]!)}  p25 $${m(pct(0.25))}  median $${m(pct(0.5))}  ` +
    `p75 $${m(pct(0.75))}  max $${m(sorted[sorted.length - 1]!)}  avg $${m(avg)}`
);

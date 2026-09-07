// Terminal watcher: prints notional + all-in cost per $1M on a timer, reading the
// same logs/cycles.jsonl the bot writes and the cost ladder (bot.ts) reads. Purely
// local file reads - no exchange calls, no orders, safe to start/stop any time,
// independent of the bot's own process. Run it on the same box as the bot (or
// wherever this checkout's logs/ is), in its own terminal:
//
//   npx tsx scripts/watch-cost.ts          # every 10 min (default)
//   npx tsx scripts/watch-cost.ts 5        # every 5 min instead
//
// Shows two cost readings because "total cost per 1M" is ambiguous and both
// readings answer a different question:
//   - cumulative: the stable, run-long picture (all cycles ever logged here).
//   - recent:     the same trailing window and all-in formula the ladder itself
//                 uses (COST_LADDER_CYCLES) - this is WHY the notional is what it
//                 is right now, and is deliberately noisier.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { cycleAllInCostUsd, costPerMillionUsd } from "../src/metrics.js";
import type { CycleSummary } from "../src/metrics.js";

const LOG_FILE = fileURLToPath(new URL("../logs/cycles.jsonl", import.meta.url));
const intervalMs = (Number(process.argv[2]) || 10) * 60_000;
const windowCycles = Math.max(config.costLadderCycles || 12, 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCycles(): CycleSummary[] {
  if (!existsSync(LOG_FILE)) return [];
  const out: CycleSummary[] = [];
  for (const line of readFileSync(LOG_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CycleSummary);
    } catch {
      // Skip a torn line - the bot writes each cycle as one appendFileSync, but a
      // read mid-write could still catch a partial last line.
    }
  }
  return out;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function report(): void {
  const cycles = readCycles();
  const stamp = new Date().toISOString();

  if (cycles.length === 0) {
    console.log(`${stamp}  no cycles recorded yet in ${LOG_FILE}`);
    return;
  }

  // Length just checked above, so this index always exists - noUncheckedIndexedAccess
  // can't see that, hence the assertion.
  const last = cycles[cycles.length - 1]!;
  const ageMin = (Date.now() - last.ts) / 60_000;
  const stale = ageMin > intervalMs / 60_000 + 5 ? `  [STALE - last cycle ${ageMin.toFixed(0)}m ago, bot may be stopped]` : "";

  let cumFee = 0;
  let cumPnl = 0;
  let cumVol = 0;
  for (const c of cycles) {
    cumFee += (c.bpsBurned / 10000) * c.volumeUsd;
    cumPnl += c.pnlUsd ?? 0;
    cumVol += c.volumeUsd;
  }
  const cumAllIn = cumFee - cumPnl;
  const cumPerMillion = cumVol > 0 ? (cumAllIn / cumVol) * 1e6 : null;
  const cumFeePerMillion = cumVol > 0 ? (cumFee / cumVol) * 1e6 : null;
  // "Drag" is a cost, so it's -pnl (a loss is positive drag, a gain is negative
  // drag/an offset) - matches how it's been discussed throughout this project:
  // all-in = fees + drag, both stated as positive numbers when they cost money.
  const cumPnlDragPerMillion = cumVol > 0 ? (-cumPnl / cumVol) * 1e6 : null;

  const windowed = cycles.slice(-windowCycles);
  const recentPerMillion = costPerMillionUsd(
    windowed.map((c) => ({ costUsd: cycleAllInCostUsd(c), volumeUsd: c.volumeUsd })),
    windowCycles
  );

  console.log(`${stamp}  cycles=${cycles.length}  notional=${money(last.notionalUsd)}${stale}`);
  console.log(
    cumPerMillion == null
      ? "  cumulative all-in: n/a (no volume yet)"
      : `  cumulative all-in: ${money(cumPerMillion)}/1M  ` +
          `(fees ${money(cumFeePerMillion ?? 0)}/1M, PnL drag ${money(cumPnlDragPerMillion ?? 0)}/1M)  over ${money(cumVol)} volume`
  );
  console.log(
    `  recent (last ${windowCycles} cycles): ` +
      (recentPerMillion == null
        ? `n/a (${windowed.length}/${windowCycles} cycles so far)`
        : `${money(recentPerMillion)}/1M`) +
      " - driving current notional\n"
  );
}

console.log(
  `Watching ${LOG_FILE} every ${intervalMs / 60_000}min (cost ladder window: ${windowCycles} cycles). Ctrl+C to stop.\n`
);
report();
setInterval(report, intervalMs);

// Read-only: answers "how often does a patient (maker) close actually work,
// and how many tries does it take?" - the one thing that can't be known ahead
// of time, since a taker-only close never attempts a maker chase at all.
// Only meaningful for cycles recorded while CLOSE_MAKER_FIRST=true.
import { readFileSync, existsSync } from "node:fs";

interface CycleRow {
  closeMakerFirst: boolean;
  closeUsedTaker?: boolean;
  closeChaseAttempts?: number;
  openChaseAttempts: number;
  openUsedTaker: boolean;
}

function readJsonl(path: string): CycleRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const cycles = readJsonl("logs/cycles.jsonl");
const withMakerClose = cycles.filter((c) => c.closeMakerFirst);

if (withMakerClose.length === 0) {
  console.log("No cycles yet with CLOSE_MAKER_FIRST=true - nothing to report until it's been running a while.");
  process.exit(0);
}

const filledAsMaker = withMakerClose.filter((c) => c.closeUsedTaker === false).length;
const fellBackToTaker = withMakerClose.filter((c) => c.closeUsedTaker === true).length;
const fillRate = (filledAsMaker / withMakerClose.length) * 100;

console.log(`Closes recorded with patient (maker-first) closing on: ${withMakerClose.length}`);
console.log(`  Filled as maker (the cheap way):    ${filledAsMaker}  (${fillRate.toFixed(1)}%)`);
console.log(`  Fell back to instant (taker):        ${fellBackToTaker}  (${(100 - fillRate).toFixed(1)}%)`);

const byAttempts: Record<number, number> = {};
for (const c of withMakerClose) {
  if (c.closeChaseAttempts != null) byAttempts[c.closeChaseAttempts] = (byAttempts[c.closeChaseAttempts] ?? 0) + 1;
}
console.log("\nHow many tries it took to close (when it filled as maker):");
for (const [attempt, count] of Object.entries(byAttempts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  try ${attempt}: ${count}`);
}

// Same "how many tries, and does it ever give up to taker" question for opens,
// now easy to check with openUsedTaker alongside the existing attempts count.
const openFallbacks = cycles.filter((c) => c.openUsedTaker).length;
console.log(`\nOpens that fell back to taker (should be rare/never unless OPEN_TAKER_FALLBACK=true): ${openFallbacks} / ${cycles.length}`);

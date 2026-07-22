// Read-only: compares completed cycles (cycles.jsonl) and skipped cycles
// (events.jsonl "cycle_skipped") grouped by the NOTIONAL_USD that was active
// when each was recorded. Requires the notionalUsd tagging added to both logs -
// older entries recorded before that change are untagged and excluded.
import { readFileSync, existsSync } from "node:fs";

interface CycleRow {
  notionalUsd?: number;
  volumeUsd: number;
  bpsBurned: number;
  makerFillRatio: number;
  openChaseAttempts: number;
  holdTimeMs?: number;
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const cycles = readJsonl("logs/cycles.jsonl") as unknown as CycleRow[];
const events = readJsonl("logs/events.jsonl");
const skipped = events.filter((e) => e.type === "cycle_skipped");

const notionals = new Set<number>();
for (const c of cycles) if (c.notionalUsd != null) notionals.add(c.notionalUsd);
for (const s of skipped) if (typeof s.notionalUsd === "number") notionals.add(s.notionalUsd);

if (notionals.size === 0) {
  console.log("No tagged data yet - restart the bot to start recording notionalUsd on every cycle/skip.");
  process.exit(0);
}

console.log(
  "notional".padEnd(10) +
    "completed".padStart(11) +
    "skipped".padStart(9) +
    "successRate".padStart(13) +
    "avgAttempts".padStart(13) +
    "avgVol/cyc".padStart(12) +
    "avgBps".padStart(9) +
    "avgHoldMs".padStart(11)
);

for (const n of [...notionals].sort((a, b) => a - b)) {
  const cs = cycles.filter((c) => c.notionalUsd === n);
  const sk = skipped.filter((s) => s.notionalUsd === n);
  const total = cs.length + sk.length;
  const successRate = total > 0 ? (cs.length / total) * 100 : 0;
  const avgAttempts = cs.length ? cs.reduce((a, c) => a + c.openChaseAttempts, 0) / cs.length : NaN;
  const avgVol = cs.length ? cs.reduce((a, c) => a + c.volumeUsd, 0) / cs.length : NaN;
  const avgBps = cs.length ? cs.reduce((a, c) => a + c.bpsBurned, 0) / cs.length : NaN;
  const holds = cs.map((c) => c.holdTimeMs).filter((v): v is number => v != null);
  const avgHold = holds.length ? holds.reduce((a, v) => a + v, 0) / holds.length : NaN;

  console.log(
    `$${n}`.padEnd(10) +
      String(cs.length).padStart(11) +
      String(sk.length).padStart(9) +
      `${successRate.toFixed(0)}%`.padStart(13) +
      avgAttempts.toFixed(2).padStart(13) +
      `$${avgVol.toFixed(0)}`.padStart(12) +
      avgBps.toFixed(2).padStart(9) +
      avgHold.toFixed(0).padStart(11)
  );
}

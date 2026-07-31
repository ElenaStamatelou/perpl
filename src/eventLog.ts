import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));
mkdirSync(LOG_DIR, { recursive: true });
const EVENTS_FILE = `${LOG_DIR}events.jsonl`;

/**
 * One structured line per "interesting" event that today only exists as
 * ephemeral console text - chase attempts (fills/cancels/rejects, with the
 * book context at post time), skipped cycles, trend-guard/chase-abort pauses,
 * watchdog force-closes, and session drops/reconnects/backoffs. Meant for
 * offline analysis across many runs (which chase params to retune, how much
 * volume-time trend-guard costs, connection reliability over days) rather
 * than for a human to tail live - cycles.jsonl and the console already cover
 * that. Fire-and-forget sync append, same pattern as metrics.ts/cycles.jsonl.
 */
export function logEvent(type: string, data: Record<string, unknown>): void {
  appendFileSync(EVENTS_FILE, JSON.stringify({ ts: Date.now(), type, ...data }) + "\n");
}

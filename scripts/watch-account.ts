// Polls /v1/trading/account-history for new NON-TRADING credits (deposits,
// protocol transfers/rebates, funding, ...) and pushes an ntfy alert for each
// one - independent of the bot process, so it still works while the bot is
// stopped. Meant to run on a schedule (see crontab), not the live bot loop.
//
//   npx tsx scripts/watch-account.ts
//
// State (the last event already seen) is kept in logs/watch-account-state.json
// so re-runs don't re-alert on the same event. On the very first run ever (no
// state file yet) it just records the current newest event as the baseline
// and sends nothing - otherwise the first run would dump the account's entire
// history as a burst of "new" alerts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAccountHistory } from "../src/restClient.js";
import { AccountEventType, type AccountEvent } from "../src/types.js";
import { sendNtfyMessage } from "../src/ntfyNotifier.js";

// Settlement (position close/open collateral moves) and IncreasePositionCollateral
// are your own trading activity, not the platform sending you anything - excluded
// so this only fires on genuinely external money movement, same distinction
// scripts/list-deposits.ts already draws.
const MONEY_EVENTS = new Set([
  AccountEventType.Deposit,
  AccountEventType.Withdrawal,
  AccountEventType.Funding,
  AccountEventType.TransferToProtocol,
  AccountEventType.TransferFromProtocol,
  AccountEventType.Liquidation,
  AccountEventType.Deleveraging,
  AccountEventType.Unwinding,
]);

const STATE_DIR = fileURLToPath(new URL("../logs/", import.meta.url));
mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = `${STATE_DIR}watch-account-state.json`;
const PAGE_SIZE = 20;

const usd = (a: unknown) => Number(a ?? 0) / 1e6;
const eventKey = (e: AccountEvent) => `${e.at.b}:${e.at.tx}:${e.at.l ?? 0}`;

function loadLastSeenKey(): string | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return (JSON.parse(readFileSync(STATE_FILE, "utf8")) as { lastSeenKey: string | null }).lastSeenKey;
  } catch {
    return null;
  }
}

function saveLastSeenKey(key: string): void {
  writeFileSync(STATE_FILE, JSON.stringify({ lastSeenKey: key }, null, 2));
}

async function main() {
  const page = await getAccountHistory(PAGE_SIZE); // newest-first
  if (page.d.length === 0) return;

  const lastSeenKey = loadLastSeenKey();
  if (lastSeenKey == null) {
    // First run ever - just seed state, don't alert on pre-existing history.
    saveLastSeenKey(eventKey(page.d[0]!));
    console.log(`Seeded baseline at ${new Date(page.d[0]!.at.t ?? 0).toISOString()} - no alerts sent.`);
    return;
  }

  // Newest-first: collect until we hit the last-seen event, then reverse to
  // chronological order so alerts arrive in the order the events happened.
  const fresh: AccountEvent[] = [];
  for (const e of page.d) {
    if (eventKey(e) === lastSeenKey) break;
    fresh.push(e);
  }
  fresh.reverse();

  if (fresh.length === 0) {
    console.log("No new account events.");
    return;
  }
  if (fresh.length === PAGE_SIZE) {
    console.warn(
      `WARNING: all ${PAGE_SIZE} fetched events were new - some events between polls may have been missed. ` +
        `Consider polling more often or raising PAGE_SIZE.`
    );
  }

  for (const e of fresh) {
    saveLastSeenKey(eventKey(e)); // advance even for events we don't alert on
    if (!MONEY_EVENTS.has(e.et)) continue;
    const amt = usd(e.a);
    if (amt <= 0) continue; // only incoming credits, not withdrawals/debits

    const label = AccountEventType[e.et] ?? `type${e.et}`;
    console.log(`New credit: ${label} +$${amt.toFixed(2)} (balance now $${usd(e.b).toFixed(2)})`);
    await sendNtfyMessage(
      `Perpl sent you $${amt.toFixed(2)}`,
      `${label}: +$${amt.toFixed(2)}\nBalance now: $${usd(e.b).toFixed(2)}\n${new Date(e.at.t ?? 0).toISOString()}`,
      { tags: "moneybag", priority: "high" }
    );
  }
}

main().catch((err) => {
  console.error("watch-account failed:", err);
  process.exit(1);
});

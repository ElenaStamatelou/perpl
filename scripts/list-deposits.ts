// Read-only: walks /v1/trading/account-history and prints each non-trading
// balance event (deposits, withdrawals, funding, protocol transfers) with its
// type LABELLED by the API, rather than inferred from balance deltas.
//
//   npx tsx scripts/list-deposits.ts                  # back to 2026-07-01
//   npx tsx scripts/list-deposits.ts 2026-06-01       # back to a custom date
//   npx tsx scripts/list-deposits.ts 2026-07-01 --all # every event type
//
// account-history returns an event per settlement, so the full history is huge
// (50k+ events). Two things keep this tractable: a large page size, and an
// early stop once the API has paged back past the target date - history comes
// back newest-first, so there is no reason to keep walking older pages.
import { getAccountHistory } from "../src/restClient.js";
import { AccountEventType, type AccountEvent } from "../src/types.js";

const showAll = process.argv.includes("--all");
const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const STOP_BEFORE = new Date(`${dateArg ?? "2026-07-01"}T00:00:00Z`).getTime();
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 1000; // API may cap this lower
const MAX_PAGES = 5000;

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

function weekOf(ms: number): string {
  const d = new Date(ms);
  const anchor = new Date(d);
  anchor.setUTCHours(18, 0, 0, 0);
  let back = (d.getUTCDay() - 3 + 7) % 7;
  if (back === 0 && d.getTime() < anchor.getTime()) back = 7;
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  const f = (x: Date) => x.toISOString().slice(5, 10);
  return `${f(start)} 18:00 -> ${f(end)} 18:00`;
}

const usd = (a: unknown) => Number(a ?? 0) / 1e6;

async function main() {
  console.log(`Paging back to ${new Date(STOP_BEFORE).toISOString().slice(0, 10)} (page size ${PAGE_SIZE})...`);
  const events: AccountEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let oldestSeen = Infinity;
  let reachedTarget = false;

  do {
    const page = await getAccountHistory(PAGE_SIZE, cursor);
    events.push(...page.d);
    for (const e of page.d) oldestSeen = Math.min(oldestSeen, e.at.t ?? Infinity);
    cursor = page.np;
    pages++;
    if (pages % 5 === 0 || !cursor) {
      const oldest = Number.isFinite(oldestSeen) ? new Date(oldestSeen).toISOString().slice(0, 16) : "-";
      console.error(`  ...${pages} pages, ${events.length} events, oldest ${oldest}`);
    }
    if (oldestSeen < STOP_BEFORE) { reachedTarget = true; break; }
  } while (cursor && pages < MAX_PAGES);

  const oldestIso = Number.isFinite(oldestSeen) ? new Date(oldestSeen).toISOString() : "n/a";
  console.log(`\nFetched ${events.length} events across ${pages} page(s). Oldest: ${oldestIso}`);
  if (!reachedTarget && pages >= MAX_PAGES) {
    console.warn("WARNING: stopped at MAX_PAGES - history is still truncated.");
  } else if (!reachedTarget && !cursor) {
    console.log("Reached the true start of account history (no more pages).");
  }

  const shown = events
    .filter((e) => showAll || MONEY_EVENTS.has(e.et))
    .sort((a, b) => (a.at.t ?? 0) - (b.at.t ?? 0));

  if (shown.length === 0) {
    console.log("\nNo matching events. Try --all to see every event type.");
    return;
  }

  console.log("\nTimestamp (UTC)        Type                       Amount $     Balance $   Week");
  console.log("-".repeat(100));
  const byType = new Map<string, { n: number; sum: number }>();
  const byWeekType = new Map<string, Map<string, number>>();

  for (const e of shown) {
    const t = e.at.t ?? 0;
    const label = AccountEventType[e.et] ?? `type${e.et}`;
    const amt = usd(e.a);
    const wk = weekOf(t);
    console.log(
      `${new Date(t).toISOString().slice(0, 19).replace("T", " ")}  ` +
        `${label.padEnd(26)} ${amt.toFixed(2).padStart(11)} ${usd(e.b).toFixed(2).padStart(13)}   ${wk}`
    );
    const agg = byType.get(label) ?? { n: 0, sum: 0 };
    byType.set(label, { n: agg.n + 1, sum: agg.sum + amt });
    if (!byWeekType.has(wk)) byWeekType.set(wk, new Map());
    const wm = byWeekType.get(wk)!;
    wm.set(label, (wm.get(label) ?? 0) + amt);
  }

  console.log("\n" + "=".repeat(60));
  console.log("TOTALS BY TYPE");
  console.log("=".repeat(60));
  for (const [label, { n, sum }] of [...byType].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${label.padEnd(28)} ${String(n).padStart(4)}x  ${sum.toFixed(2).padStart(12)}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("BY WEEK (Wed 18:00 -> Wed 18:00 UTC)");
  console.log("=".repeat(60));
  for (const [wk, wm] of [...byWeekType].sort()) {
    console.log(`\n  ${wk}`);
    for (const [label, sum] of [...wm].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${label.padEnd(28)} ${sum.toFixed(2).padStart(12)}`);
    }
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

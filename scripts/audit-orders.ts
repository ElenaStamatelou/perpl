// Read-only: shows how recent orders terminated (status + reason), to diagnose no-fill runs.
import { getOrderHistory } from "../src/restClient.js";
import { OrderStatus, OrderStatusReason } from "../src/types.js";

const sinceMs = process.argv[2] ? Number(process.argv[2]) : Date.now() - 30 * 60 * 1000;

const page = await getOrderHistory(100);
const recent = page.d.filter((o) => (o.at.t ?? 0) >= sinceMs);

const counts = new Map<string, number>();
for (const o of recent) {
  const key = `st=${OrderStatus[o.st] ?? o.st} sr=${OrderStatusReason[o.sr] ?? o.sr}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

console.log(`Orders in window: ${recent.length}`);
for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}x ${key}`);
}

console.log("\nSample of the 10 most recent:");
for (const o of recent.slice(0, 10)) {
  console.log(
    `  t=${o.t} p=${o.p} s=${o.os} filled=${o.fs} st=${OrderStatus[o.st] ?? o.st} sr=${OrderStatusReason[o.sr] ?? o.sr} fl=${o.fl} at=${new Date(o.at.t ?? 0).toISOString()}`
  );
}

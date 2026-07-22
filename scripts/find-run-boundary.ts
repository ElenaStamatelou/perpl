// Read-only: prints recent fill timestamps so run boundaries (time gaps) are visible.
import { getFills } from "../src/restClient.js";

const page = await getFills(100);
let prev: number | undefined;
for (const f of page.d) {
  const t = f.at.t ?? 0;
  const gapSec = prev != null ? ((prev - t) / 1000).toFixed(0) : "-";
  console.log(`${new Date(t).toISOString()}  t=${f.t} size=${f.s} fee=${f.f}  gap_to_next=${gapSec}s`);
  prev = t;
}

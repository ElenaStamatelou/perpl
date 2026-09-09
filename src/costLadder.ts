import { config, type LadderPoint } from "./config.js";

/**
 * The active cost -> notional breakpoints, sorted ascending by cost (always >= 2).
 *
 * When COST_LADDER_POINTS is set it is used verbatim. Otherwise the curve is the
 * original two-point line: full size (config.notionalUsd) at/below tier1, floor
 * (config.costLadderNotionalFloor) at/above tier2, linear between.
 */
export function ladderPoints(): LadderPoint[] {
  const custom = config.costLadderPoints;
  if (custom && custom.length >= 2) return custom;
  return [
    { costPerMillion: config.costLadderTier1UsdPerM, notionalUsd: config.notionalUsd },
    { costPerMillion: config.costLadderTier2UsdPerM, notionalUsd: config.costLadderNotionalFloor },
  ];
}

/**
 * Notional (USD, per leg) for the next open, given the recent all-in cost per $1M.
 *
 * Piecewise-linear over ladderPoints(): below the first point's cost the first
 * point's notional applies, above the last point's cost the last point's, and
 * each segment in between is a straight line. A null cost ("not enough cycles to
 * judge yet" - every cold start and session restart) maps to the smallest
 * notional on the curve, so size has to earn its way up once real data backs it.
 *
 * `floorUsd` is a hard lower bound applied last (the market's min_posting_amount,
 * so the resulting order is always large enough for the exchange to accept).
 */
export function ladderNotionalUsd(costPerMillion: number | null, floorUsd: number): number {
  const pts = ladderPoints();
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;

  let raw: number;
  if (costPerMillion == null) {
    raw = Math.min(...pts.map((p) => p.notionalUsd));
  } else if (costPerMillion <= first.costPerMillion) {
    raw = first.notionalUsd;
  } else if (costPerMillion >= last.costPerMillion) {
    raw = last.notionalUsd;
  } else {
    raw = last.notionalUsd;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (costPerMillion <= b.costPerMillion) {
        const frac = (costPerMillion - a.costPerMillion) / (b.costPerMillion - a.costPerMillion);
        raw = a.notionalUsd + (b.notionalUsd - a.notionalUsd) * frac;
        break;
      }
    }
  }

  return Math.max(raw, floorUsd);
}

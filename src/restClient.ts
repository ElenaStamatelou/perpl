import { signedFetch } from "./auth.js";
import { config } from "./config.js";
import type {
  AccountEvent,
  Announcement,
  CandleSeries,
  Context,
  Fill,
  HistoryPage,
  Order,
  Position,
  RefCode,
} from "./types.js";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** GET /v1/pub/context - unauthenticated. */
export async function getContext(): Promise<Context> {
  const res = await fetch(`${config.apiUrl}/v1/pub/context`);
  return json<Context>(res);
}

/** GET /v1/market-data/:market_id/candles/:resolution/:from-:to - unauthenticated, max 1024 candles. */
export async function getCandles(
  marketId: number,
  resolutionSec: number,
  fromMs: number,
  toMs: number
): Promise<CandleSeries> {
  const res = await fetch(
    `${config.apiUrl}/v1/market-data/${marketId}/candles/${resolutionSec}/${fromMs}-${toMs}`
  );
  return json<CandleSeries>(res);
}

async function fetchPage<T>(target: string): Promise<HistoryPage<T>> {
  const res = await signedFetch("GET", target);
  return json<HistoryPage<T>>(res);
}

async function fetchAllPages<T>(basePath: string, count = 100): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ count: String(count) });
    if (cursor) params.set("page", cursor);
    const page = await fetchPage<T>(`${basePath}?${params.toString()}`);
    items.push(...page.d);
    cursor = page.np;
  } while (cursor);
  return items;
}

/** GET /v1/trading/fills (one page). */
export function getFills(count = 100, page?: string) {
  const params = new URLSearchParams({ count: String(count) });
  if (page) params.set("page", page);
  return fetchPage<Fill>(`/v1/trading/fills?${params.toString()}`);
}

/** Walks every page of /v1/trading/fills. */
export function getAllFills(): Promise<Fill[]> {
  return fetchAllPages<Fill>("/v1/trading/fills");
}

/** GET /v1/trading/order-history (one page). */
export function getOrderHistory(count = 100, page?: string) {
  const params = new URLSearchParams({ count: String(count) });
  if (page) params.set("page", page);
  return fetchPage<Order>(`/v1/trading/order-history?${params.toString()}`);
}

/** GET /v1/trading/position-history (one page). */
export function getPositionHistory(count = 50, page?: string) {
  const params = new URLSearchParams({ count: String(count) });
  if (page) params.set("page", page);
  return fetchPage<Position>(`/v1/trading/position-history?${params.toString()}`);
}

/** Walks every page of /v1/trading/position-history. */
export function getAllPositionHistory(): Promise<Position[]> {
  return fetchAllPages<Position>("/v1/trading/position-history", 50);
}

/** GET /v1/trading/account-history (one page). */
export function getAccountHistory(count = 50, page?: string) {
  const params = new URLSearchParams({ count: String(count) });
  if (page) params.set("page", page);
  return fetchPage<AccountEvent>(`/v1/trading/account-history?${params.toString()}`);
}

/** GET /v1/profile/ref-code - signed. */
export async function getRefCode(): Promise<RefCode | null> {
  const res = await signedFetch("GET", "/v1/profile/ref-code");
  if (res.status === 404) return null;
  return json<RefCode>(res);
}

/** GET /v1/profile/announcements - optional auth. */
export async function getAnnouncements(): Promise<Announcement[]> {
  const res = await signedFetch("GET", "/v1/profile/announcements");
  const data = await json<{ ver: number; active: Announcement[] }>(res);
  return data.active;
}

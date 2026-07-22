import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { buildApiKeySignInFrame } from "./auth.js";
import { config } from "./config.js";
import {
  ORDER_REASON_TEXT,
  OrderStatus,
  OrderStatusReason,
  OrderType,
  type Account,
  type Fill,
  type Heartbeat,
  type Order,
  type OrderRequest,
  type Position,
  type Wallet,
} from "./types.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
/** Grace window to let a possibly-later non-failure status override an early failure (see websocket.md dedup rules). */
const FAILURE_GRACE_MS = 300;
/** Safety net if the server never responds for an rq at all (should not happen in practice). */
const PLACE_ORDER_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (order: Order) => void;
  reject: (err: Error) => void;
  settled: boolean;
  graceTimer?: NodeJS.Timeout;
  outerTimer: NodeJS.Timeout;
}

/**
 * Authenticated /ws/v1/trading client: sign-in, sequence tracking + forced
 * reconnect on gaps, rq idempotency-key generation, and order placement with
 * the delivery/dedup semantics from websocket.md.
 */
export class TradingClient extends EventEmitter {
  private ws?: WebSocket;
  private lastSn?: number;
  private currentBlock = 0;
  private currentBlockAt = 0; // Date.now() when the last heartbeat set currentBlock
  private msPerBlock = 500; // EMA of observed block time, refined from heartbeats
  private accountId?: number;
  private lfr = 0; // last-forwarded request id, from Account.lfr
  private localCounter = 0;
  private pending = new Map<number, PendingRequest>();
  private positions = new Map<number, Position>(); // pid -> latest known Position
  private pingInterval?: ReturnType<typeof setInterval>;
  private retryCount = 0;
  private closedByUser = false;
  private authenticated = false;
  private lastMessageAt = 0;
  private staleInterval?: ReturnType<typeof setInterval>;
  // Human-readable order log: market metadata for formatting + dedupe of printed states.
  private marketMeta = new Map<number, { symbol: string; priceDecimals: number; sizeDecimals: number }>();
  private printedOrderStatus = new Map<number, number>(); // oid -> last printed st

  connect(): void {
    this.closedByUser = false;
    this.ws = new WebSocket(`${config.wsUrl}/ws/v1/trading`);

    this.ws.on("open", async () => {
      this.authenticated = false;
      const frame = await buildApiKeySignInFrame();
      this.ws?.send(JSON.stringify(frame));

      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
        }
      }, 30_000);

      // Staleness watchdog: heartbeats arrive every block (~400ms); 15s of total
      // silence means a half-open socket. terminate() forces the close path
      // (failAllPending + reconnect) instead of trading on frozen state.
      this.lastMessageAt = Date.now();
      if (this.staleInterval) clearInterval(this.staleInterval);
      this.staleInterval = setInterval(() => {
        if (this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > 15_000) {
          console.warn("[trading] feed silent for 15s - terminating socket to force reconnect");
          this.lastMessageAt = 0;
          this.ws?.terminate();
        }
      }, 5_000);
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", (code) => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.staleInterval) clearInterval(this.staleInterval);
      this.failAllPending(new Error(`WebSocket closed (code ${code})`));
      this.emit("close", code);
      if (!this.closedByUser) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => this.emit("error", err));
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.ws?.close();
  }

  getAccountId(): number | undefined {
    return this.accountId;
  }

  /** Registers decimals/symbol so order log lines print real sizes and prices. */
  setMarketMeta(marketId: number, meta: { symbol: string; priceDecimals: number; sizeDecimals: number }): void {
    this.marketMeta.set(marketId, meta);
  }

  private describeOrder(mkt: number, t: number, size: number, price?: number): string {
    const m = this.marketMeta.get(mkt);
    const sym = m?.symbol || `mkt${mkt}`;
    const verb =
      t === OrderType.OpenLong ? "open long " :
      t === OrderType.OpenShort ? "open short" :
      t === OrderType.CloseLong ? "close long " :
      t === OrderType.CloseShort ? "close short" : `type${t}`;
    const s = m ? (size / 10 ** m.sizeDecimals).toFixed(m.sizeDecimals) : String(size);
    const p = price && m ? `@ $${(price / 10 ** m.priceDecimals).toFixed(m.priceDecimals)}` : "@ market";
    return `${verb} ${s} ${sym} ${p}`;
  }

  private logOrderEvent(order: Order): void {
    if (process.env.PERPL_DEBUG_WS) return; // raw frames already visible in debug mode
    if (order.t === 5) return; // cancel requests: the cancelled order itself gets the line
    const last = this.printedOrderStatus.get(order.oid);
    if (last === order.st) return;
    this.printedOrderStatus.set(order.oid, order.st);
    if (this.printedOrderStatus.size > 800) {
      for (const k of this.printedOrderStatus.keys()) {
        this.printedOrderStatus.delete(k);
        if (this.printedOrderStatus.size <= 400) break;
      }
    }

    const time = new Date().toLocaleTimeString("en-GB");
    const base = `${time}  ${this.describeOrder(order.mkt, order.t, order.os, order.p)}`;
    const isClose = order.t === OrderType.CloseLong || order.t === OrderType.CloseShort;
    const m = this.marketMeta.get(order.mkt);
    const fillPx = m && order.fp ? `$${(order.fp / 10 ** m.priceDecimals).toFixed(m.priceDecimals)}` : "";
    switch (order.st) {
      case OrderStatus.Open:
        console.log(`${base}  pending`);
        break;
      case OrderStatus.PartiallyFilled:
        console.log(`${base}  partially filled${fillPx ? ` @ ${fillPx}` : ""}`);
        break;
      case OrderStatus.Filled:
      case OrderStatus.Executed:
        console.log(`${base}  ${isClose ? "closed" : "filled"}${fillPx ? ` @ ${fillPx}` : ""}`);
        break;
      case OrderStatus.Canceled:
        console.log(`${base}  cancelled (repricing)`);
        break;
      case OrderStatus.Expired:
        console.log(`${base}  expired (repricing)`);
        break;
      case OrderStatus.Failed: {
        const reason = ORDER_REASON_TEXT[order.sr] ?? OrderStatusReason[order.sr] ?? `code ${order.sr}`;
        console.log(`${base}  rejected: ${reason}`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Chain head estimate. Heartbeats only arrive every few seconds; using the raw
   * last-seen block stamps orders with an lb that can already be in the past when
   * it reaches the exchange ("Invalid Expiry Time"). Extrapolate forward by the
   * observed block time, capped at 10s of drift so a dead feed can't run away.
   */
  getCurrentBlock(): number {
    if (this.currentBlockAt === 0) return this.currentBlock;
    const elapsed = Math.min(Date.now() - this.currentBlockAt, 10_000);
    return this.currentBlock + Math.floor(elapsed / this.msPerBlock);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Reads the live position cache (updated synchronously from Positions[Snapshot|Update]) - no event race. */
  findPositionByOid(oid: number): Position | undefined {
    for (const p of this.positions.values()) {
      if (p.oid === oid) return p;
    }
    return undefined;
  }

  /**
   * Finds an open position on a market, regardless of which order created it.
   * More robust than matching by oid: a position's `oid` field has been observed
   * as 0/stale rather than reliably reflecting the order that just filled it.
   */
  findOpenPositionForMarket(marketId: number): Position | undefined {
    for (const p of this.positions.values()) {
      if (p.mkt === marketId && p.st === 1 /* Open */) return p;
    }
    return undefined;
  }

  getPosition(pid: number): Position | undefined {
    return this.positions.get(pid);
  }

  private nextRequestId(): number {
    this.localCounter = Math.max(this.localCounter, this.lfr) + 1;
    return this.localCounter;
  }

  /** Sends an OrderRequest and resolves/rejects once its status is definitive (websocket.md dedup rules). */
  placeOrder(req: Omit<OrderRequest, "mt" | "rq">): Promise<Order> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Trading WebSocket is not connected"));
    }
    const rq = this.nextRequestId();
    const fullRequest: OrderRequest = { mt: 22, rq, ...req };
    if (process.env.PERPL_DEBUG_WS) console.debug("[trading:ws:out]", JSON.stringify(fullRequest));

    return new Promise<Order>((resolve, reject) => {
      const outerTimer = setTimeout(() => {
        const p = this.pending.get(rq);
        if (p && !p.settled) {
          p.settled = true;
          this.pending.delete(rq);
          reject(new Error(`No status received for rq=${rq} within ${PLACE_ORDER_TIMEOUT_MS}ms`));
        }
      }, PLACE_ORDER_TIMEOUT_MS);

      this.pending.set(rq, { resolve, reject, settled: false, outerTimer });
      this.ws!.send(JSON.stringify(fullRequest));
    });
  }

  cancelOrder(marketId: number, orderId: number, expiryBlocks = config.orderExpiryBlocks): Promise<Order> {
    if (this.accountId == null) throw new Error("Not authenticated yet (no accountId)");
    return this.placeOrder({
      mkt: marketId,
      acc: this.accountId,
      oid: orderId,
      t: 5, // Cancel
      s: 0,
      fl: 0,
      lv: 0,
      lb: this.currentBlock + expiryBlocks,
    });
  }

  private handleMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    const msg = JSON.parse(raw);
    if (process.env.PERPL_DEBUG_WS) console.debug("[trading:ws:in]", raw);
    switch (msg.mt) {
      case 2: // Pong - reply to our keep-alive ping, nothing to do
        break;
      case 3: {
        // StatusResponse - generic ack/error frame for requests rejected before becoming
        // a trackable Order (e.g. malformed lb). Doesn't carry rq, so we can only
        // correlate it to a pending request when exactly one is in flight.
        this.emit("status", msg);
        const isError = msg.status && msg.status.code !== 0 && msg.status.code !== 200;
        if (isError) {
          console.warn("[trading] StatusResponse error:", JSON.stringify(msg));
          if (this.pending.size === 1) {
            const [rq, p] = [...this.pending.entries()][0]!;
            if (!p.settled) {
              p.settled = true;
              if (p.graceTimer) clearTimeout(p.graceTimer);
              clearTimeout(p.outerTimer);
              this.pending.delete(rq);
              p.reject(new Error(`Request rejected: ${msg.status.error ?? `code ${msg.status.code}`}`));
            }
          }
        }
        break;
      }
      case 19: {
        // WalletSnapshot
        const wallet = msg as Wallet;
        this.lastSn = wallet.sn;
        const account = config.accountId
          ? wallet.as?.find((a) => a.id === config.accountId)
          : wallet.as?.[0];
        if (!account && config.accountId) {
          // Pinned account missing: refuse to authenticate rather than fall back to
          // another account (which may already be driven by a different bot process).
          this.emit(
            "error",
            new Error(
              `PERPL_ACCOUNT_ID=${config.accountId} not found on this wallet ` +
                `(accounts: ${wallet.as?.map((a) => a.id).join(", ") || "none"})`
            )
          );
          break;
        }
        if (account) {
          this.accountId = account.id;
          this.lfr = Math.max(this.lfr, account.lfr ?? 0);
        }
        this.authenticated = true;
        this.retryCount = 0;
        this.emit("authenticated", wallet);
        this.emit("wallet", wallet);
        break;
      }
      case 20: // WalletUpdate
        this.emit("wallet", msg);
        break;
      case 21: {
        // AccountUpdate
        const account = msg as Account;
        if (account.id === this.accountId) {
          this.lfr = Math.max(this.lfr, account.lfr ?? 0);
        }
        this.emit("account", account);
        break;
      }
      case 23: // OrdersSnapshot
        this.emit("orders", msg.d as Order[]);
        for (const o of (msg.d as Order[]) ?? []) this.handleOrderMessage(o);
        break;
      case 24: {
        // OrdersUpdate
        const orders = msg.d as Order[];
        this.emit("orders", orders);
        for (const o of orders) this.handleOrderMessage(o);
        break;
      }
      case 25: // FillsUpdate
        this.emit("fills", msg.d as Fill[]);
        break;
      case 26: // PositionsSnapshot
      case 27: {
        // PositionsUpdate
        const positions = msg.d as Position[];
        for (const p of positions) this.positions.set(p.pid, p);
        this.emit("positions", positions);
        break;
      }
      case 28: // AccountStatsUpdate
        this.emit("accountStats", msg.d);
        break;
      case 100: {
        // Heartbeat
        const hb = msg as Heartbeat;
        if (this.lastSn != null && hb.sn !== this.lastSn + 1) {
          // Sequence gap: messages may have been lost, force a reconnect for fresh state.
          this.ws?.close();
          return;
        }
        this.lastSn = hb.sn;
        const now = Date.now();
        if (this.currentBlockAt > 0 && hb.h > this.currentBlock) {
          const observed = (now - this.currentBlockAt) / (hb.h - this.currentBlock);
          // EMA clamped to a sane band so one delayed heartbeat can't skew the estimate.
          this.msPerBlock = Math.min(2000, Math.max(100, this.msPerBlock * 0.7 + observed * 0.3));
        }
        this.currentBlock = hb.h;
        this.currentBlockAt = now;
        this.emit("heartbeat", hb);
        break;
      }
      default:
        console.debug("[trading] unhandled message type:", JSON.stringify(msg));
        break;
    }
  }

  private handleOrderMessage(order: Order): void {
    this.emit("order", order);
    this.logOrderEvent(order);

    const p = this.pending.get(order.rq);
    if (!p || p.settled) return;

    const isFailure = order.st === OrderStatus.Failed;
    if (!isFailure) {
      if (p.graceTimer) clearTimeout(p.graceTimer);
      clearTimeout(p.outerTimer);
      p.settled = true;
      this.pending.delete(order.rq);
      p.resolve(order);
      return;
    }

    if (!p.graceTimer) {
      p.graceTimer = setTimeout(() => {
        if (p.settled) return;
        clearTimeout(p.outerTimer);
        p.settled = true;
        this.pending.delete(order.rq);
        // A definitive Failed status is a legitimate outcome (has oid/fee/etc.), not a
        // transport error - resolve so callers can inspect .st themselves, same as any
        // other terminal status. Rejection is reserved for cases with no Order at all
        // (timeout, disconnect, StatusResponse-level rejection).
        p.resolve(order);
      }, FAILURE_GRACE_MS);
    }
  }

  private failAllPending(err: Error): void {
    for (const [rq, p] of this.pending) {
      if (p.settled) continue;
      p.settled = true;
      if (p.graceTimer) clearTimeout(p.graceTimer);
      clearTimeout(p.outerTimer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)];
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }
}

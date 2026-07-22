import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./config.js";
import type { Heartbeat, L2Book, L2PriceLevel, Trade, TradeSeries } from "./types.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

interface Level {
  size: number;
  orders: number;
}

/**
 * Public /ws/v1/market-data client for one market: maintains a local L2 book
 * and re-emits trades. No auth required (websocket.md).
 */
export class MarketDataClient extends EventEmitter {
  private ws?: WebSocket;
  private bids = new Map<number, Level>();
  private asks = new Map<number, Level>();
  private lastSn?: number;
  private retryCount = 0;
  private closedByUser = false;
  private lastMessageAt = 0;
  private staleInterval?: ReturnType<typeof setInterval>;
  // Rolling mid-price samples (scaled units) for short-horizon drift measurement.
  private midHistory: Array<{ t: number; mid: number }> = [];

  constructor(private readonly marketId: number) {
    super();
  }

  connect(): void {
    this.closedByUser = false;
    this.ws = new WebSocket(`${config.wsUrl}/ws/v1/market-data`);

    this.ws.on("open", () => {
      this.retryCount = 0;
      this.subscribe();
      this.emit("open");

      // Staleness watchdog: heartbeats arrive every block (~400ms), so a silent
      // feed means a half-open socket (server gone without a TCP close) - the
      // book silently freezes and every "at the touch" price is fiction. Force
      // the socket down so the normal reconnect path takes over.
      this.lastMessageAt = Date.now();
      if (this.staleInterval) clearInterval(this.staleInterval);
      this.staleInterval = setInterval(() => {
        if (this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > 15_000) {
          console.warn("[market-data] feed silent for 15s - terminating socket to force reconnect");
          this.lastMessageAt = 0;
          this.ws?.terminate();
        }
      }, 5_000);
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", () => {
      if (this.staleInterval) clearInterval(this.staleInterval);
      this.emit("close");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => this.emit("error", err));
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.ws?.close();
  }

  getBestBid(): number | undefined {
    return this.maxKey(this.bids);
  }

  getBestAsk(): number | undefined {
    return this.minKey(this.asks);
  }

  getMid(): number | undefined {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid == null || ask == null) return undefined;
    return (bid + ask) / 2;
  }

  /**
   * Absolute mid drift (bps) between now and ~windowMs ago. Returns undefined
   * until enough history has accumulated (at least half the window). Used as a
   * trend guard: maker cycles opened into a trending market fill at adversely
   * selected prices and close worse - better to wait for chop.
   */
  getMidDriftBps(windowMs: number): number | undefined {
    const now = Date.now();
    const current = this.getMid();
    if (current == null) return undefined;
    const cutoff = now - windowMs;
    // Oldest sample that is still inside the window.
    const anchor = this.midHistory.find((s) => s.t >= cutoff);
    if (!anchor || now - anchor.t < windowMs / 2) return undefined;
    return Math.abs(((current - anchor.mid) / anchor.mid) * 10000);
  }

  private subscribe(): void {
    this.bids.clear();
    this.asks.clear();
    this.ws?.send(
      JSON.stringify({
        mt: 5,
        subs: [
          { stream: `heartbeat@${config.chainId}`, subscribe: true },
          { stream: `order-book@${this.marketId}`, subscribe: true },
          { stream: `trades@${this.marketId}`, subscribe: true },
        ],
      })
    );
  }

  private handleMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    const msg = JSON.parse(raw);
    switch (msg.mt) {
      case 15: // L2BookSnapshot
      case 16: {
        // L2BookUpdate
        const book = msg as L2Book;
        this.applyLevels(book.bid, this.bids);
        this.applyLevels(book.ask, this.asks);
        const mid = this.getMid();
        if (mid != null) {
          const now = Date.now();
          this.midHistory.push({ t: now, mid });
          // Keep ~60s of history; drift windows are much shorter.
          while (this.midHistory.length > 0 && this.midHistory[0]!.t < now - 60_000) {
            this.midHistory.shift();
          }
        }
        this.emit("book", { bestBid: this.getBestBid(), bestAsk: this.getBestAsk() });
        break;
      }
      case 17: // TradesSnapshot
      case 18: {
        // TradesUpdate
        const series = msg as TradeSeries;
        for (const trade of series.d as Trade[]) this.emit("trade", trade);
        break;
      }
      case 100: {
        // Heartbeat
        const hb = msg as Heartbeat;
        if (this.lastSn != null && hb.sn !== this.lastSn + 1) {
          // Gap: resubscribe to get a fresh snapshot rather than a full reconnect.
          this.subscribe();
        }
        this.lastSn = hb.sn;
        this.emit("heartbeat", hb);
        break;
      }
      default:
        break;
    }
  }

  private applyLevels(levels: L2PriceLevel[] | undefined, book: Map<number, Level>): void {
    if (!levels) return;
    for (const level of levels) {
      if (level.o === 0) book.delete(level.p);
      else book.set(level.p, { size: level.s, orders: level.o });
    }
  }

  private maxKey(m: Map<number, Level>): number | undefined {
    let best: number | undefined;
    for (const k of m.keys()) if (best === undefined || k > best) best = k;
    return best;
  }

  private minKey(m: Map<number, Level>): number | undefined {
    let best: number | undefined;
    for (const k of m.keys()) if (best === undefined || k < best) best = k;
    return best;
  }

  private scheduleReconnect(): void {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)];
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }
}

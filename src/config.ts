import "dotenv/config";

export type Network = "testnet" | "mainnet";

const NETWORK_DEFAULTS: Record<Network, { apiUrl: string; wsUrl: string; chainId: number }> = {
  mainnet: {
    apiUrl: "https://app.perpl.xyz/api",
    wsUrl: "wss://app.perpl.xyz",
    chainId: 143,
  },
  testnet: {
    apiUrl: "https://testnet.perpl.xyz/api",
    wsUrl: "wss://testnet.perpl.xyz",
    chainId: 10143,
  },
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const network = (process.env.PERPL_NETWORK?.trim().toLowerCase() || "testnet") as Network;
if (network !== "testnet" && network !== "mainnet") {
  throw new Error(`PERPL_NETWORK must be "testnet" or "mainnet", got "${network}"`);
}
const defaults = NETWORK_DEFAULTS[network];

// Pin to a specific account id - required when running multiple bots on one wallet
// (request ids are a per-account sequence, so two bots must NEVER share an account).
// Unset = use the wallet's first account. Anything non-numeric fails loudly here so a
// placeholder like FILL_ME_IN can't silently fall back to the first account.
const accountIdRaw = process.env.PERPL_ACCOUNT_ID?.trim() || "";
const pinnedAccountId = accountIdRaw ? Number(accountIdRaw) : 0;
if (accountIdRaw && (!Number.isInteger(pinnedAccountId) || pinnedAccountId <= 0)) {
  throw new Error(`PERPL_ACCOUNT_ID must be a positive integer account id, got "${accountIdRaw}"`);
}

export const config = {
  network,
  apiUrl: process.env.PERPL_API_URL?.trim() || defaults.apiUrl,
  wsUrl: process.env.PERPL_WS_URL?.trim() || defaults.wsUrl,
  chainId: Number(process.env.PERPL_CHAIN_ID) || defaults.chainId,
  origin: process.env.PERPL_ORIGIN?.trim() || "http://localhost",

  // Only needed for the one-time enrollment script (scripts/enroll-key.ts).
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY?.trim() || "",

  // Populated after enrollment.
  get apiKey(): string {
    return requireEnv("PERPL_API_KEY");
  },
  get apiKeySecretHex(): string {
    return requireEnv("PERPL_API_KEY_SECRET").replace(/^0x/, "");
  },

  // 0 = first account on the wallet; otherwise the pinned account id (see above).
  accountId: pinnedAccountId,

  // Trading parameters. Default 31 = SOL on mainnet.
  marketId: Number(process.env.MARKET_ID) || 31,
  notionalUsd: Number(process.env.NOTIONAL_USD) || 2500,
  leverage: Number(process.env.LEVERAGE) || 10,
  // Per-attempt wait for a resting post-only order. Orders on Perpl live at most
  // order_ttl_blocks (~8s on SOL), so this is effectively "wait out the order's life".
  makerTimeoutMs: Number(process.env.MAKER_TIMEOUT_MS) || 8000,
  // How many times to (re)post at the current touch before giving up on the leg.
  // Re-posts happen when price moves away or the order expires - in a fast trend
  // attempts burn quickly, so this is higher than the old cancel-every-4s design.
  makerChaseAttempts: Number(process.env.MAKER_CHASE_ATTEMPTS) || 10,
  // Short pause before re-pricing after a CrossesBook rejection (didn't rest at all, no need to wait a full timeout).
  chaseRetryBackoffMs: Number(process.env.CHASE_RETRY_BACKOFF_MS) || 250,
  // Opens pay maker/taker fees, so by default a failed open chase just skips the cycle
  // (costs nothing) instead of paying 6.9bps taker. Set true to force-complete opens.
  openTakerFallback: (process.env.OPEN_TAKER_FALLBACK ?? "false").toLowerCase() === "true",
  // Closes are ALWAYS free on Perpl (maker or taker), so the only close cost is the
  // half-spread (~0.1bps on SOL at our size). Default: skip the maker chase entirely and
  // close instantly via IOC market - ends position risk sooner and avoids the cancel-race
  // complexity. Set true to maker-chase closes anyway (no fee benefit, only spread).
  closeMakerFirst: (process.env.CLOSE_MAKER_FIRST ?? "false").toLowerCase() === "true",
  maxTakerSlippageBps: Number(process.env.MAX_TAKER_SLIPPAGE_BPS) || 15,
  // Clamped per-market to market.order_ttl_blocks by orderEngine.ts (all 6 mainnet markets are 20 as of writing).
  orderExpiryBlocks: Number(process.env.ORDER_EXPIRY_BLOCKS) || 15,
  hardTimeoutMs: Number(process.env.HARD_TIMEOUT_MS) || 15000,
  // Positions have shown up several seconds after their triggering fill in practice -
  // this is how long we poll before deciding a position genuinely can't be confirmed.
  positionConfirmTimeoutMs: Number(process.env.POSITION_CONFIRM_TIMEOUT_MS) || 25000,
  // 0 = run until manually stopped (Ctrl+C).
  targetVolumeUsd: Number(process.env.TARGET_VOLUME_USD) || 0,
  // 0 = no time limit. Otherwise stop cleanly after this long. MAX_RUNTIME_HOURS
  // is the more convenient unit for multi-hour runs; if set (nonzero) it wins
  // over MAX_RUNTIME_MIN.
  maxRuntimeMin: Number(process.env.MAX_RUNTIME_HOURS) > 0
    ? Number(process.env.MAX_RUNTIME_HOURS) * 60
    : Number(process.env.MAX_RUNTIME_MIN) || 0,
  cycleRestMs: Number(process.env.CYCLE_REST_MS) || 1000,
  // Optional: if both set, the rest between cycles is randomized in this range
  // instead of using the fixed cycleRestMs above.
  cycleRestMinMs: process.env.CYCLE_REST_MIN_MS ? Number(process.env.CYCLE_REST_MIN_MS) : undefined,
  cycleRestMaxMs: process.env.CYCLE_REST_MAX_MS ? Number(process.env.CYCLE_REST_MAX_MS) : undefined,
  // Trend guard: don't open when |mid drift| over the window exceeds the threshold -
  // maker fills in a trending market are adversely selected and close worse (PnL drag).
  // Set threshold to 0 to disable.
  trendGuardWindowMs: Number(process.env.TREND_GUARD_WINDOW_MS) || 10000,
  trendGuardMaxDriftBps: Number(process.env.TREND_GUARD_MAX_DRIFT_BPS ?? 3.5),

  // Mid-chase abort: the trend guard above only checks BEFORE a cycle starts -
  // once a chase is underway, price can still run away attempt after attempt
  // (observed live: a chase that kept re-pricing upward for 6 straight attempts
  // before filling, costing 10.47bps vs the ~0bps baseline). This aborts the
  // chase early (falling back to the normal "no fill -> flip side" path) once
  // the touch has moved against us by chaseAbortConfirmAttempts consecutive
  // reprices AND the cumulative move from the chase's starting price exceeds
  // chaseAbortDriftBps - the consecutive-attempts requirement exists so a
  // single noisy tick doesn't trigger it (avoids whipsawing on random moves).
  // Set chaseAbortDriftBps to 0 to disable.
  chaseAbortDriftBps: Number(process.env.CHASE_ABORT_DRIFT_BPS ?? 3.5),
  chaseAbortConfirmAttempts: Number(process.env.CHASE_ABORT_CONFIRM_ATTEMPTS) || 2,

  // Cost ladder: scale notional down as recent all-in cost per $1M rises, and back
  // up as it falls, so volume is weighted toward cheap conditions. Rungs are
  // <= tier1 -> notionalUsd (full), tier1..tier2 -> mid, > tier2 -> floor.
  //
  // The window is a cycle COUNT, not wall-clock: at the observed ~68 cycles/hr, 12
  // cycles is ~10 minutes, but a time window empties out whenever the bot is
  // skipping cycles - measured on the historical logs it had too few samples to
  // judge for 27% of cycles, and so fell back to full size exactly when the market
  // was trending and expensive. A cycle count can never go blind that way.
  //
  // The floor deliberately keeps trading rather than stopping: the metric is a
  // ratio, so it stays valid at floor size, and a bot that stopped would freeze its
  // own input and never learn that conditions had improved.
  // Set costLadderCycles to 0 to disable (notional stays at notionalUsd).
  costLadderCycles: Number(process.env.COST_LADDER_CYCLES ?? 12),
  costLadderTier1UsdPerM: Number(process.env.COST_LADDER_TIER1_USD_PER_M ?? 60),
  costLadderTier2UsdPerM: Number(process.env.COST_LADDER_TIER2_USD_PER_M ?? 70),
  costLadderNotionalMid: Number(process.env.COST_LADDER_NOTIONAL_MID ?? 200),
  costLadderNotionalFloor: Number(process.env.COST_LADDER_NOTIONAL_FLOOR ?? 9),

  // Optional: periodic summary push via ntfy.sh (https://ntfy.sh/<topic>, no account
  // needed). Blank = disabled (no-op).
  ntfyTopic: process.env.NTFY_TOPIC?.trim() || "",

  // Two push cadences, both only checked when a cycle closes (so the real gap
  // rounds up to the next cycle boundary):
  //   summary - frequent pulse, ntfy only
  //   report  - slower full report, ntfy + the xlsx snapshot row
  summaryIntervalHours: Number(process.env.SUMMARY_INTERVAL_HOURS) || 2,
  reportIntervalHours: Number(process.env.REPORT_INTERVAL_HOURS) || 12,
};

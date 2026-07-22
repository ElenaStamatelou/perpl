// Types ported from https://github.com/PerplFoundation/api-docs (types.md, rest-endpoints.md, websocket.md)

// ---------- Primitives ----------
export type ChainID = number;
export type InstanceID = number;
export type TokenID = number;
export type MarketID = number;
export type PerpetualID = number;
export type FeeLevelID = number;
export type AccountID = number;
export type OrderID = number;
export type RequestID = number;
export type PositionID = number;
export type Decimals = number;
export type Fraction = number; // hundredths
export type Micros = number; // 10^-6
export type Amount = string; // decimal string
export type Price = number; // scaled uint
export type SPrice = number; // scaled signed
export type Size = number; // scaled uint

// ---------- Timestamps ----------
export interface BlockTimestamp {
  b?: number;
  t?: number;
}

export interface BlockTxTimestamp extends BlockTimestamp {
  tx?: number;
  txid?: string;
}

export interface BlockTxLogTimestamp extends BlockTxTimestamp {
  l?: number;
}

// ---------- Chain & protocol ----------
export interface GasPrice {
  at: BlockTimestamp;
  h: number;
  max: Amount;
  p95: Amount;
  p50: Amount;
  min: Amount;
  base: Amount;
}

export interface Chain {
  ver: number;
  chain_id: ChainID;
  name?: string;
  icons?: string[];
  native_token?: Token;
  rpc_urls?: string[];
  block_explorer_urls?: string[];
  gas: GasPrice;
}

export interface Token {
  ver: number;
  id?: TokenID;
  address?: string;
  symbol: string;
  name: string;
  icon?: string;
  decimals: Decimals;
  display_precision: Decimals;
  usd_index?: string;
}

export interface ProtocolInstance {
  ver: number;
  id: InstanceID;
  address: string; // exchange contract
  collateral_token_id: TokenID;
  min_account_open_amount: Amount;
  min_deposit_amount: Amount;
  min_withdraw_amount: Amount;
  max_account_equity?: Amount;
  max_account_trigger_orders: number;
}

export interface Context {
  chain: Chain;
  instances: ProtocolInstance[];
  tokens: Token[];
  markets: Market[];
}

// ---------- Market ----------
export interface MarketConfig {
  at: BlockTimestamp;
  is_open: boolean;
  price_decimals: Decimals;
  size_decimals: Decimals;
  min_posting_amount: Amount;
  min_settle_amount: Amount;
  initial_margin: Fraction; // e.g. 1000 = 10% = max 10x
  maintenance_margin: Fraction;
  maker_fee: Micros; // negative = rebate
  taker_fee: Micros;
  recycle_fee: Amount;
}

export interface MarketState {
  at: BlockTimestamp;
  orl: Price; // oracle price
  mrk: Price; // mark price
  lst: Price; // last trade price
  mid: Price; // mid price
  bid: Price; // best bid
  ask: Price; // best ask
  prv: Price; // price 24h ago
  dv: Size; // daily volume (size)
  dva: Amount; // daily volume (amount)
  oi: Size; // open interest
  tvl: Amount;
}

export interface FundingEvent {
  at: BlockTimestamp;
  feb: number;
  rate: Micros;
  idx: Price;
  ppl: SPrice;
  sum: SPrice;
  div: number;
}

export interface Market {
  ver: number;
  id: MarketID;
  instance_id: InstanceID;
  perpetual_id: PerpetualID;
  symbol: string;
  name: string;
  size_units: string;
  icon: string;
  funding_interval_sec: number;
  funding_interval_blocks: number;
  order_ttl_blocks: number;
  order_retry_blocks: number;
  order_max_market_slippage_bps: number;
  config: MarketConfig;
  state: MarketState;
  funding: FundingEvent;
  points_boost_bps: number;
}

// ---------- Orders ----------
export enum OrderType {
  Unspecified = 0,
  OpenLong = 1,
  OpenShort = 2,
  CloseLong = 3,
  CloseShort = 4,
  Cancel = 5,
  IncreasePositionCollateral = 6,
  Change = 7,
}

export enum OrderFlags {
  GoodTillCancel = 0,
  PostOnly = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 4,
}

export enum OrderStatus {
  Unspecified = 0,
  Pending = 1,
  Open = 2,
  PartiallyFilled = 3,
  Filled = 4,
  Canceled = 5,
  Expired = 6,
  Failed = 7,
  Untriggered = 8,
  Triggered = 9,
  Executed = 10,
}

export enum TriggerPriceCondition {
  Unspecified = 0,
  GTELast = 1,
  LTELast = 2,
  GTEMark = 3,
  LTEMark = 4,
}

// Non-exhaustive; see docs/websocket.md and docs/types.md for full list (68 values).
export enum OrderStatusReason {
  Unspecified = 0,
  AmountExceedsAvailableBalance = 1,
  AccountFrozen = 2,
  ClearingSelfMatchingOrder = 9,
  CloseOrderExceedsPosition = 10,
  CloseOrderPositionMismatch = 11,
  CrossesBook = 13,
  ExceedsLastExecutionBlock = 14,
  ForwardingReverted = 15,
  InvalidExpiryBlock = 20,
  OrderDescIdTooLow = 32,
  OrderForwardingNotAllowed = 34,
  OrderPlaced = 35,
  MakerOrderFilled = 22,
  TakerOrderFilled = 43,
  ImmediateOrCancelExecuted = 16,
  ImmediateOrderUnderMinimum = 17,
  OrderCancelled = 28,
  PriceOutOfRange = 40,
  UnmatchedLotRemainsInFillOrKill = 46,
}

/** Friendly one-liners for the rejection reasons an operator actually sees. */
export const ORDER_REASON_TEXT: Record<number, string> = {
  [OrderStatusReason.AmountExceedsAvailableBalance]: "insufficient balance",
  [OrderStatusReason.CrossesBook]: "would cross the book",
  [OrderStatusReason.ExceedsLastExecutionBlock]: "expired in transit (exchange lag)",
  [OrderStatusReason.InvalidExpiryBlock]: "invalid expiry block",
  [OrderStatusReason.CloseOrderPositionMismatch]: "position already closed/changed",
  [OrderStatusReason.CloseOrderExceedsPosition]: "close size exceeds position",
  [OrderStatusReason.OrderDescIdTooLow]: "request id conflict",
  [OrderStatusReason.OrderForwardingNotAllowed]: "forwarding not allowed (enable 1-click trading)",
  [OrderStatusReason.PriceOutOfRange]: "price out of range",
};

/** Order state as reported by REST history / WS snapshots+updates. */
export interface Order {
  at: BlockTxLogTimestamp;
  c: BlockTxTimestamp;
  rq: RequestID;
  mkt: MarketID;
  acc: AccountID;
  oid: OrderID;
  scid: OrderID;
  st: OrderStatus;
  sr: OrderStatusReason;
  t: OrderType;
  r?: boolean; // remove from open orders
  p?: Price;
  os: Size; // original size
  fp: Price; // fill price (weighted avg)
  fs: Size; // filled size
  f: Amount; // fee paid
  tif?: number;
  fl: OrderFlags;
  tp?: Price;
  tpc?: TriggerPriceCondition;
  lp?: PositionID;
  mm: number;
  lv: number; // leverage, hundredths
}

/** Frame sent Client -> Server (mt: 22) to place/cancel/modify an order. */
export interface OrderRequest {
  mt: 22;
  rq: RequestID; // strictly increasing per account, idempotency key
  mkt: MarketID;
  acc: AccountID;
  oid?: OrderID; // required for Cancel/Change
  t: OrderType;
  p?: Price; // limit price, 0/omitted for market
  s: Size;
  a?: Amount; // collateral increase amount (IncreasePositionCollateral)
  ms?: number; // max market-order slippage, bps - the "threshold price" protection
  tif?: number; // documented but superseded by lb in every real example
  fl: OrderFlags;
  tp?: Price;
  tpc?: TriggerPriceCondition;
  tr?: RequestID; // linked trigger request id
  lp?: PositionID; // linked position id (required for Close*)
  lv: number; // leverage, hundredths (e.g. 1000 = 10x)
  lb: number; // last execution/expiry block; trigger orders must set 0
}

// ---------- Fills ----------
export enum LiquiditySide {
  Unspecified = 0,
  Maker = 1,
  Taker = 2,
}

export interface Fill {
  at: BlockTxLogTimestamp;
  mkt: MarketID;
  acc: AccountID;
  oid: OrderID;
  t: OrderType;
  l: LiquiditySide;
  p?: Price;
  s: Size;
  f: Amount; // fee, negative = rebate
}

// ---------- Positions ----------
export enum PositionType {
  Unspecified = 0,
  Long = 1,
  Short = 2,
}

export enum PositionStatus {
  Unspecified = 0,
  Open = 1,
  Closed = 2,
  Liquidated = 3,
  Deleveraged = 4,
  Unwound = 5,
  Failed = 6,
}

export enum PositionStatusReason {
  PositionClosed = 13,
  PositionDecreased = 14,
  PositionDeleveraged = 15,
  PositionIncreased = 17,
  PositionInverted = 18,
  PositionLiquidated = 19,
  PositionOpened = 21,
  PositionUnwound = 22,
}

export interface Position {
  at: BlockTxLogTimestamp;
  mkt: MarketID;
  acc: AccountID;
  pid: PositionID;
  rq: RequestID;
  oid: OrderID;
  st: PositionStatus;
  sr: PositionStatusReason;
  sd: PositionType;
  c: Amount; // collateral
  ep: Price; // entry price
  epr?: number;
  s: Size;
  fee: Amount;
  efs: SPrice;
  lv: number;
  dpnl?: Amount;
  fnd?: Amount;
  xp?: Price; // exit price
  xfs: SPrice;
  ots: BlockTxTimestamp;
  e?: Position[];
}

// ---------- Account & wallet ----------
export enum AccountEventType {
  Unspecified = 0,
  Deposit = 1,
  Withdrawal = 2,
  IncreasePositionCollateral = 3,
  Settlement = 4,
  Liquidation = 5,
  TransferToProtocol = 6,
  TransferFromProtocol = 7,
  Funding = 8,
  Deleveraging = 9,
  Unwinding = 10,
  PositionCollateralDecreased = 11,
  LastForwardedDescIdReset = 12,
}

export interface AccountEvent {
  at: BlockTxLogTimestamp;
  in: InstanceID;
  id: AccountID;
  et: AccountEventType;
  m?: MarketID;
  r?: RequestID;
  o?: OrderID;
  p?: PositionID;
  a: Amount;
  b: Amount;
  lb: Amount;
  f: Amount;
}

export interface AccountStats {
  mt: number;
  in: InstanceID;
  id: AccountID;
  td: Amount; // total deposits
  tw: Amount; // total withdrawals
  tv: Amount; // total trading volume
  trp: Amount; // total realized pnl
  wr: number; // win rate, bps
  tt: number; // total trades
}

/** Account snapshot/update, also delivered as mt 21 (AccountUpdate). */
export interface Account {
  mt?: number;
  in: InstanceID;
  id: AccountID;
  fr: boolean; // frozen
  fw: boolean; // allows forwarding
  lfr: RequestID; // last forwarded request id - seed rq generation from this
  b: Amount; // balance
  lb: Amount; // locked balance
  h?: AccountEvent[];
}

/** WalletSnapshot (mt: 19). */
export interface Wallet {
  mt: 19;
  sn?: number; // sequence number - seed trading-WS heartbeat tracking from this
  at: BlockTimestamp;
  addr: string;
  n: number;
  fl: FeeLevelID;
  as?: Account[];
  sts?: AccountStats[];
}

// ---------- Market data payloads ----------
export interface L2PriceLevel {
  p: Price;
  s: Size;
  o: number; // number of orders; o===0 means remove level
}

export enum TradeSide {
  Unspecified = 0,
  Buy = 1,
  Sell = 2,
}

export interface Trade {
  at: BlockTxLogTimestamp;
  p: Price;
  s: Size;
  sd: TradeSide;
}

export interface Candle {
  t: number; // open timestamp ms
  o: Price;
  c: Price;
  h: Price;
  l: Price;
  v: Amount;
  n: number;
}

// ---------- Profile ----------
export interface RefCode {
  code: string;
  limit?: number;
  used?: number;
  volume?: Amount;
  created_at: number;
}

export interface Announcement {
  id: number;
  title: string;
  content: string;
}

// ---------- API keys ----------
export type ScopeMask = number;
export const ScopeRead: ScopeMask = 1 << 0;
export const ScopeTrade: ScopeMask = 1 << 1; // implies read
export const ScopeAll: ScopeMask = ScopeRead | ScopeTrade;

export interface ApiKeyPayloadRequest {
  chain_id: number;
  address: string;
  public_key: string; // 0x-hex, 32 bytes
  scope_mask: ScopeMask;
  label: string;
  expires_at?: number;
  ip_cidrs?: string[];
  target_profile?: string;
}

export interface ApiKeyPayloadResponse {
  typed_data: unknown; // EIP-712 typed data, sign exactly as returned
  mac: string;
}

export interface ApiKeyEnrollRequest {
  chain_id: number;
  address: string;
  typed_data: unknown;
  mac: string;
  signature: string; // wallet EIP-712 signature, 0x-hex
  pop_signature: string; // Ed25519 proof-of-possession, 0x-hex
  target_profile?: string;
}

export interface ApiKeyInfo {
  api_key: string;
  address: string;
  scope_mask: ScopeMask;
  label: string;
  ip_cidrs: string[];
  origin: string;
  expires_at: number;
  last_used_at: number;
  created_at: number;
}

export interface ApiKeyEnrollResponse {
  api_key: ApiKeyInfo;
}

// ---------- WebSocket envelope ----------
export interface MessageHeader {
  mt: number;
  sid?: number;
  sn?: number;
  cid?: number;
  ses?: string;
}

export enum MsgType {
  Ping = 1,
  Pong = 2,
  StatusResponse = 3,
  SubscriptionRequest = 5,
  SubscriptionResponse = 6,
  GasPriceUpdate = 7,
  MarketConfigUpdate = 8,
  MarketStateUpdate = 9,
  MarketFundingUpdate = 10,
  CandlesSnapshot = 11,
  CandlesUpdate = 12,
  L2BookSnapshot = 15,
  L2BookUpdate = 16,
  TradesSnapshot = 17,
  TradesUpdate = 18,
  WalletSnapshot = 19,
  WalletUpdate = 20,
  AccountUpdate = 21,
  OrderRequest = 22,
  OrdersSnapshot = 23,
  OrdersUpdate = 24,
  FillsUpdate = 25,
  PositionsSnapshot = 26,
  PositionsUpdate = 27,
  AccountStatsUpdate = 28,
  ApiKeySignIn = 29,
  Heartbeat = 100,
}

export interface ApiKeySignInRequest extends MessageHeader {
  mt: 29;
  chain_id: number;
  api_key: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface SubscriptionRequest extends MessageHeader {
  mt: 5;
  subs: Array<{ stream: string; subscribe: boolean }>;
}

export interface SubscriptionResponse extends MessageHeader {
  mt: 6;
  subs: Array<{
    stream: string;
    sid?: number;
    status?: { code: number; error?: string };
  }>;
}

export interface L2Book extends MessageHeader {
  mt: 15 | 16;
  at: BlockTimestamp;
  bid: L2PriceLevel[];
  ask: L2PriceLevel[];
}

export interface TradeSeries extends MessageHeader {
  mt: 17 | 18;
  d: Trade[];
}

export interface CandleSeries extends MessageHeader {
  mt: 11 | 12;
  at: BlockTimestamp;
  r: number;
  d: Candle[];
}

export interface MarketStateUpdate extends MessageHeader {
  mt: 9;
  d: Record<MarketID, MarketState | undefined>;
}

export interface Heartbeat extends MessageHeader {
  mt: 100;
  sn: number;
  h: number; // latest head block number
}

export interface WalletOrders extends MessageHeader {
  mt: 23 | 24;
  at: BlockTimestamp;
  d: Order[];
}

export interface WalletFills extends MessageHeader {
  mt: 25;
  at: BlockTimestamp;
  d: Fill[];
}

export interface WalletPositions extends MessageHeader {
  mt: 26 | 27;
  at: BlockTimestamp;
  d: Position[];
}

export interface AccountStatsUpdate extends MessageHeader {
  mt: 28;
  d?: AccountStats;
}

// ---------- REST history pagination ----------
export interface HistoryPage<T> {
  d: T[];
  np: string; // next page cursor
}

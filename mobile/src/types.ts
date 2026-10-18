export type HistoryRange =
  | "intraday"
  | "fiveDay"
  | "daily"
  | "weekly"
  | "monthly"
  | "minute1"
  | "minute5"
  | "minute15"
  | "minute30"
  | "minute60"
  | "minute120";
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  provisional?: boolean;
  /** Previously received historical bar omitted from the latest response. */
  retained?: boolean;
}
export interface History {
  symbol: string;
  candles: Candle[];
  previousClose?: number;
  retainedCoverage?: {
    receivedAt: number;
    minutes: number;
    decoded: import("./historyCoverage.ts").Coverage;
    persistence: "saved" | "memory";
  };
  sourceCoverage?: {
    receivedAt: number;
    range: HistoryRange;
    rawBars: number;
    decoded: import("./historyCoverage.ts").Coverage;
  };
}
export interface Quote {
  symbol: string;
  description?: string;
  lastPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  netChange?: number;
  netPercentChange?: number;
  quoteTime?: number;
  tradeTime?: number;
  isRealtime?: boolean;
  assetMainType?: string;
  assetSubType?: string;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  closePrice?: number;
  totalVolume?: number;
  high52Week?: number;
  low52Week?: number;
  marketCap?: number;
  peRatio?: number;
  sharesOutstanding?: number;
}
export interface Position {
  symbol: string;
  description?: string;
  assetType: string;
  quantity: number;
  averagePrice?: number;
  marketValue?: number;
  dayProfitLoss?: number;
}
export interface Account {
  id: string;
  displayNumber: string;
  accountType: string;
  liquidationValue?: number;
  cashBalance?: number;
  buyingPower?: number;
  positions: Position[];
}
export type Side = "BUY" | "SELL";
export interface TradeExecution {
  id: string;
  symbol: string;
  side: Side;
  time: number;
  price: number;
  quantity: number;
}
export type OrderKind = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type Duration = "DAY" | "GOOD_TILL_CANCEL";
export type OrderSession = "NORMAL" | "AM" | "PM" | "SEAMLESS";
export interface Draft {
  symbol: string;
  side: Side;
  kind: OrderKind;
  quantity: number;
  limitPrice?: string;
  stopPrice?: string;
  duration: Duration;
  session?: OrderSession;
}
export interface Order {
  id: string;
  status: string;
  symbol: string;
  side?: Side;
  kind?: OrderKind;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  duration?: Duration;
  enteredAt?: number;
  executions?: TradeExecution[];
  cancelable: boolean;
  editable: boolean;
  isSimpleEquity: boolean;
  isSingleLeg?: boolean;
  assetType?: string;
  session?: string;
  cancelUnavailableReason?: string;
}
export interface Prepared {
  id: string;
  draft: Draft;
  accountID: string;
  accountDisplay: string;
  quote: Quote;
  estimatedValue?: number;
  availableShares: number;
  buyingPower?: number;
  preparedAt: number;
  replacementOrderID?: string;
  isDemo: boolean;
}
export interface SessionStatus {
  configured: boolean;
  authenticated: boolean;
  expiresAt?: number;
  refreshExpiresAt?: number;
  reauthorizationRequired?: boolean;
  unresolvedOperation: boolean;
}
export interface Vault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface Broker {
  subscribeAccountActivity?(onChange: () => void, onStatus?: (status: "connecting" | "live" | "fallback") => void): () => void;
  subscribeMarket?(
    symbol: string,
    callbacks: import("./marketStream.ts").MarketStreamCallbacks,
  ): () => void;
  status(): Promise<SessionStatus>;
  configure(clientID: string, clientSecret: string): Promise<void>;
  authorizationURL(): Promise<string>;
  completeAuthorization(callback: string): Promise<void>;
  disconnect(clearCredentials?: boolean): Promise<void>;
  acknowledgeReconciliation(): Promise<void>;
  accounts(): Promise<Account[]>;
  quotes(
    symbols: string[],
    options?: { fundamentals?: boolean },
  ): Promise<Quote[]>;
  history(symbol: string, range: HistoryRange): Promise<History>;
  orders(accountID: string): Promise<Order[]>;
  orderDetail(accountID: string, id: string): Promise<Order>;
  prepare(
    accountID: string,
    draft: Draft,
    replacementID?: string,
  ): Promise<Prepared>;
  submit(prepared: Prepared): Promise<{ orderID?: string }>;
  submitQuick?(accountID: string, draft: Draft): Promise<{ snapshot: Prepared; result: { orderID?: string } }>;
  cancel(accountID: string, orderID: string): Promise<void>;
}
export interface Palette {
  background: string;
  surface: string;
  text: string;
  secondary: string;
  separator: string;
  up: string;
  down: string;
  accent: string;
  premarket: string;
  postmarket: string;
}

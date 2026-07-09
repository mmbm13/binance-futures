export type StrategyId = 'ladder' | 'funding' | 'momentum' | 'liqrev' | 'bounce';

export type ExecutionMode = 'live' | 'paper';

/**
 * Common contract every strategy implements. The API server and the user-data
 * WebSocket route all lifecycle events through the active strategy instead of
 * talking to a concrete engine.
 */
export interface Strategy {
  readonly id: StrategyId;

  /** Load persisted state, fetch symbol precision, set leverage/margin. Idempotent. */
  init(): Promise<void>;

  /** Begin looking for signals / resume a cycle (POST /start). */
  start(): Promise<void>;

  /** Stop streams and cancel open orders (POST /stop). */
  stop(): Promise<void>;

  /** Reconcile local state against the exchange (called after WS reconnect). */
  sync(): Promise<void>;

  /** ORDER_TRADE_UPDATE from the user data stream. */
  onOrderUpdate(data: { order: Record<string, unknown> }): Promise<unknown>;

  /** ALGO_UPDATE from the user data stream (conditional SL/TP orders). */
  onAlgoUpdate(data: { algoOrder: Record<string, unknown> }): Promise<unknown>;

  /** Live snapshot for GET /status. */
  getMetrics(): Promise<Record<string, unknown>>;
}

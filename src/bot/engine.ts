
import { client } from './client';
import { stateManager, BotState } from './state';
import { NewFuturesOrderParams } from 'binance';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';


// ─── Configuration ───────────────────────────────────────────────────────────
const SYMBOL = 'ETHUSDT';
const LEVERAGE = 60;
const RISK_PER_TRADE = 0.01;        // 1% of account balance
const STOP_LOSS_PERCENT = 0.01;     // 1% price movement
const TAKE_PROFIT_PERCENT = 0.02;   // 2% price movement (2:1 R:R)
const ENTRY_OFFSET = 0.02;          // 2% offset for entry orders
const RISK_BUFFER = 0.90;           // 10% safety buffer for fees & slippage


// ─── Helpers ─────────────────────────────────────────────────────────────────
async function getAccountBalance(): Promise<number> {
  const res = await client.getAccountInformationV3();
  const asset = res.assets.find((a: any) => a.asset === 'USDT');
  return asset ? parseFloat(asset.walletBalance as string) : 0;
}

function roundStep(value: number, step: number): number {
  if (step === 0) return value;
  const inv = 1.0 / step;
  return Math.round(value * inv) / inv;
}

function floorStep(value: number, step: number): number {
  if (step === 0) return value;
  const inv = 1.0 / step;
  return Math.floor(value * inv) / inv;
}

/**
 * Cancel ALL orders for the symbol — both regular orders and algo orders.
 * Since Dec 2025 Binance moved conditional orders (STOP_MARKET, etc.) to Algo API,
 * so we must cancel both types to fully clean up.
 */
async function cancelAllOrders(): Promise<void> {
  try {
    await client.cancelAllOpenOrders({ symbol: SYMBOL });
  } catch (_) {
    // Ignore — no regular open orders is fine
  }
  try {
    await client.cancelAllAlgoOpenOrders({ symbol: SYMBOL });
  } catch (_) {
    // Ignore — no algo open orders is fine
  }
}


// ─── Bot Engine ──────────────────────────────────────────────────────────────
export const botEngine = {
  state: null as BotState | null,
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  initialized: false,
  // Execution locks to prevent race conditions
  _placingOrders: false,
  _placingExits: false,

  async init() {
    // Prevent double initialization
    if (this.initialized) {
      logger.info(`Bot already initialized, skipping.`);
      return;
    }

    this.state = await stateManager.getState();
    logger.info('Bot initializing with state', { state: this.state });

    // ── Fetch Symbol Info for Precision ────────────────────────────────────
    try {
      const exchangeInfo = await client.getExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
      if (symbolInfo) {
        const lotSizeFilter = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE') as any;
        if (lotSizeFilter) {
          this.stepSize = parseFloat(lotSizeFilter.stepSize);
          this.minQty = parseFloat(lotSizeFilter.minQty);
        }

        const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER') as any;
        if (priceFilter) this.tickSize = parseFloat(priceFilter.tickSize);

        const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL') as any;
        if (minNotionalFilter) {
          this.minNotional = parseFloat(minNotionalFilter.notional || minNotionalFilter.minNotional || '5');
        }

        logger.info('Symbol Info', { tickSize: this.tickSize, stepSize: this.stepSize, minQty: this.minQty, minNotional: this.minNotional });
      } else {
        logger.error(`Symbol ${SYMBOL} not found in exchange info!`);
      }
    } catch (e) {
      logger.error('Failed to fetch exchange info', { error: e });
    }

    // ── Set Margin Type to CROSSED ───────────────────────────────────────
    try {
      await client.setMarginType({ symbol: SYMBOL, marginType: 'CROSSED' });
      logger.info(`Margin type set to CROSSED for ${SYMBOL}`);
    } catch (e: any) {
      // -4046 = "No need to change margin type" (already CROSSED)
      const msg = e?.message || e?.body?.msg || '';
      if (e?.code === -4046 || msg.includes('No need to change margin type')) {
        logger.info(`Margin type already CROSSED for ${SYMBOL}`);
      } else {
        logger.error('Error setting margin type', { error: e });
      }
    }

    // ── Set Leverage ──────────────────────────────────────────────────────
    try {
      await client.setLeverage({ symbol: SYMBOL, leverage: LEVERAGE });
      logger.info(`Leverage set to ${LEVERAGE}x for ${SYMBOL}`);
    } catch (e) {
      logger.error('Error setting leverage', { error: e });
    }

    // ── Sync state with Binance reality ───────────────────────────────────
    await this.syncStateWithBinance();

    this.initialized = true;
    logger.info('Bot initialization complete.');
  },

  async syncStateWithBinance() {
    logger.info('Syncing state with Binance...');
    try {
      const accInfo = await client.getAccountInformationV3();
      const position = accInfo.positions.find((p) => p.symbol === SYMBOL);
      const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      const posAmt = position ? parseFloat(position.positionAmt as string) : 0;

      // Also check algo orders (SL is now an algo order since Dec 2025)
      let openAlgoOrders: any[] = [];
      try {
        openAlgoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
      } catch (_) {
        // Ignore — might fail if no algo orders exist
      }

      this.state = await stateManager.getState();
      const trackedOrders = this.state.orders || {};

      if (posAmt !== 0) {
        // ── We have an open position ──────────────────────────────────────
        logger.info(`[Sync] In Position: ${posAmt}`);

        if (this.state.phase !== 'IN_POSITION') {
          await stateManager.updatePhase('IN_POSITION');
        }

        // Check if we have exit orders placed
        const hasTP = openOrders.some(o => o.type === 'LIMIT' && o.reduceOnly);
        // SL is now an algo order (STOP_MARKET via Algo API)
        // Only count active algo orders (NEW, PENDING, TRIGGERING), not CANCELED or FINISHED
        const hasSL = openAlgoOrders.some((o: any) => 
          o.orderType === 'STOP_MARKET' && 
          (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
        );

        if (!hasTP || !hasSL) {
          logger.warn(`[Sync] Missing exit orders (TP: ${hasTP}, SL: ${hasSL}). Attempting to reconstruct...`);

          // Don't reconstruct if we're already placing exits (prevents loops)
          if (this._placingExits) {
            logger.warn('[Sync] Already placing exits, skipping reconstruction to prevent loop');
            return;
          }

          // Use getPositionsV3 for reliable entryPrice (getAccountInformationV3 may omit it)
          let entryPrice = 0;
          const absQty = Math.abs(posAmt);
          const side = posAmt > 0 ? 'LONG' : 'SHORT';

          try {
            const positionsV3 = await client.getPositionsV3({ symbol: SYMBOL });
            const posV3 = positionsV3.find((p) => parseFloat(p.positionAmt as string) !== 0);
            if (posV3) {
              entryPrice = parseFloat(posV3.entryPrice as string) || 0;
            }
          } catch (e) {
            logger.error('[Sync] Failed to fetch positionsV3', { error: e });
          }

          if (entryPrice > 0 && absQty > 0) {
            // Only cancel if we're missing BOTH orders AND not already placing exits
            if (!hasTP && !hasSL && !this._placingExits) {
              // Cancel any stale orders first
              await cancelAllOrders();
              await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Only place exits if not already placing
            if (!this._placingExits) {
              await this.placeExits(side as 'LONG' | 'SHORT', entryPrice, absQty);
              logger.info(`[Sync] Reconstructed exit orders for ${side} @ ${entryPrice}`);
            } else {
              logger.warn('[Sync] Already placing exits, skipping reconstruction');
            }
          } else {
            logger.warn(`[Sync] Cannot reconstruct exits: entryPrice=${entryPrice}, qty=${absQty}. Manual check required.`);
          }
        }

      } else {
        // ── No position ───────────────────────────────────────────────────
        if (openOrders.length > 0 || openAlgoOrders.length > 0) {
          const entries = openOrders.filter(o => o.type === 'LIMIT' && !o.reduceOnly);

          if (entries.length > 0) {
            logger.info(`[Sync] Waiting for Entry. Open entry orders: ${entries.length}`);
            if (this.state.phase !== 'WAITING_ENTRY') {
              const longEntry = entries.find(o => o.side === 'BUY');
              const shortEntry = entries.find(o => o.side === 'SELL');
              await stateManager.updatePhase('WAITING_ENTRY', this.state.cycle_id || randomUUID(), {
                longOrderId: longEntry?.orderId || trackedOrders.longOrderId,
                shortOrderId: shortEntry?.orderId || trackedOrders.shortOrderId
              });
            }
          } else {
            // Only exit orders remain but no position — clean up
            logger.info('[Sync] No position but exit/algo orders remain. Cleaning up.');
            await cancelAllOrders();
            await stateManager.updatePhase('IDLE');
          }
        } else {
          logger.info('[Sync] Idle.');
          if (this.state.phase !== 'IDLE') {
            await stateManager.updatePhase('IDLE');
          }
          
          // Start new cycle if bot is RUNNING, IDLE, and no orders exist
          // Only trigger if not already placing orders (lock check prevents duplicates)
          if (this.state.status === 'RUNNING' && !this._placingOrders) {
            // Double-check no orders exist before starting
            const hasOrders = openOrders.length > 0 || openAlgoOrders.length > 0;
            if (!hasOrders) {
              logger.info('[Sync] No orders found, starting new cycle...');
              // Use setTimeout to avoid blocking sync and allow state to settle
              setTimeout(() => {
                this.handleIdle().catch((e) =>
                  logger.error('[Sync] Error starting cycle from sync', { error: e })
                );
              }, 500);
            }
          }
        }
      }

      this.state = await stateManager.getState();
    } catch (e) {
      logger.error('Failed to sync state', { error: e });
    }
  },


  async handleOrderUpdate(data: any) {
    const order = data.order;
    logger.info('[WS] Order Update', { symbol: order.symbol, status: order.orderStatus, side: order.side, orderId: order.orderId, type: order.orderType });

    if (order.symbol !== SYMBOL) return;

    // Reload state to ensure we have the latest
    this.state = await stateManager.getState();
    if (!this.state || this.state.status === 'STOPPED') return;

    const tracked = this.state.orders || {};

    // ── 1. Handle Entry Order Fill ──────────────────────────────────────────
    const isLongEntry = order.orderId == tracked.longOrderId;
    const isShortEntry = order.orderId == tracked.shortOrderId;

    if (isLongEntry || isShortEntry) {
      if (order.orderStatus === 'FILLED') {
        const side: 'LONG' | 'SHORT' = isLongEntry ? 'LONG' : 'SHORT';
        const otherOrderId = isLongEntry ? tracked.shortOrderId : tracked.longOrderId;

        // Use WS data directly — no extra API call needed
        const entryPrice = parseFloat(order.averagePrice || order.price || '0');
        const filledQty = parseFloat(order.orderFilledAccumulatedQuantity || order.originalQuantity || '0');

        logger.info(`[WS] ${side} Entry Filled @ ${entryPrice} (Qty: ${filledQty})`);

        // Cancel the opposite straddle order
        // First check if the order exists, then cancel it
        try {
          // Check if the order is still open before trying to cancel
          const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
          const oppositeOrder = openOrders.find((o: any) => o.orderId === otherOrderId);
          
          if (oppositeOrder) {
            // Order exists, cancel it
            await client.cancelOrder({ symbol: SYMBOL, orderId: otherOrderId });
            logger.info(`[WS] Canceled opposite order: ${otherOrderId}`);
          } else {
            // Order doesn't exist in open orders - might have been filled/canceled already
            logger.info(`[WS] Opposite order ${otherOrderId} not found in open orders (likely already filled/canceled)`);
            
            // As a safety measure, cancel all non-reduceOnly LIMIT orders (entry orders)
            // This ensures we clean up any remaining entry orders
            const entryOrders = openOrders.filter((o: any) => 
              o.type === 'LIMIT' && !o.reduceOnly && o.orderId !== order.orderId
            );
            if (entryOrders.length > 0) {
              logger.info(`[WS] Canceling ${entryOrders.length} remaining entry order(s) as safety measure`);
              for (const entryOrder of entryOrders) {
                try {
                  await client.cancelOrder({ symbol: SYMBOL, orderId: entryOrder.orderId });
                  logger.info(`[WS] Canceled entry order: ${entryOrder.orderId}`);
                } catch (cancelErr: any) {
                  logger.warn(`[WS] Could not cancel entry order ${entryOrder.orderId}`, { error: cancelErr?.message || cancelErr });
                }
              }
            }
          }
        } catch (e: any) {
          logger.error(`[WS] Error canceling opposite order ${otherOrderId}`, { error: e?.message || e });
          // Fallback: try to cancel all entry orders
          try {
            const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
            const entryOrders = openOrders.filter((o: any) => 
              o.type === 'LIMIT' && !o.reduceOnly && o.orderId !== order.orderId
            );
            if (entryOrders.length > 0) {
              logger.info(`[WS] Fallback: Canceling ${entryOrders.length} entry order(s)`);
              await client.cancelAllOpenOrders({ symbol: SYMBOL });
            }
          } catch (fallbackErr: any) {
            logger.error('[WS] Fallback cancellation also failed', { error: fallbackErr?.message || fallbackErr });
          }
        }

        // Update phase to IN_POSITION first to prevent duplicate exit placement
        if (this.state.phase !== 'IN_POSITION') {
          await stateManager.updatePhase('IN_POSITION', undefined, undefined, undefined, entryPrice, side);
          // Reload state after update
          this.state = await stateManager.getState();
        }

        // Place TP/SL immediately using WS data (faster than re-fetching from API)
        // Only place if we're actually in position (state check prevents duplicates)
        if (this.state.phase === 'IN_POSITION') {
          await this.placeExits(side, entryPrice, filledQty);
        } else {
          logger.warn('[WS] Phase changed before placing exits, skipping to avoid duplicates');
        }

      } else if (order.orderStatus === 'CANCELED' || order.orderStatus === 'EXPIRED') {
        logger.info(`[WS] Tracked entry ${order.orderId} was ${order.orderStatus}`);
        // Don't sync immediately if we're placing exits - wait a bit to avoid race conditions
        if (!this._placingExits) {
          setTimeout(() => {
            this.syncStateWithBinance().catch((e) =>
              logger.error('[WS] Error syncing after entry cancel', { error: e })
            );
          }, 1000);
        } else {
          logger.info('[WS] Entry canceled but exits are being placed, skipping sync to avoid race condition');
        }
      }
      return;
    }

    // ── 2. Accumulate Realized PnL ──────────────────────────────────────────
    const rp = parseFloat(order.realisedProfit || order.rp || '0');
    if (rp !== 0) {
      logger.info(`[WS] Accumulating PnL: ${rp}`);
      await stateManager.updatePhase(this.state.phase, undefined, undefined, rp);
      if (this.state) this.state.current_pnl = (this.state.current_pnl || 0) + rp;
    }

    // ── 3. Handle Exit Order Fill ───────────────────────────────────────────
    // When SL (algo) triggers, Binance creates a regular MARKET order that
    // arrives here as ORDER_TRADE_UPDATE with FILLED status + realisedProfit.
    // When TP (limit) fills, it also arrives here.
    // Check if we're in position and this order closes it
    if (this.state.phase === 'IN_POSITION' && order.orderStatus === 'FILLED') {
      // Check if this is an exit order (reduce-only or MARKET type from SL)
      // MARKET orders from SL algo don't always have reduceOnly flag, but they close positions
      const isExitOrder = order.reduceOnly === true || order.reduceOnly === 'true' || order.type === 'MARKET';
      
      // Also check if this order has realized profit (indicates it closed a position)
      const hasRealizedProfit = parseFloat(order.realisedProfit || order.rp || '0') !== 0;
      
      if (!isExitOrder && !hasRealizedProfit) {
        return; // Not an exit order, ignore
      }

      // Always check position to see if it's closed
      // Add a small delay to allow Binance to update position after order fill
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const accInfo = await client.getAccountInformationV3();
      const position = accInfo.positions.find((p) => p.symbol === SYMBOL);
      const posAmt = position ? parseFloat(position.positionAmt as string) : 0;

      if (posAmt === 0) {
        logger.info('[WS] Position closed.');

        const finalPnl = this.state.current_pnl || 0;
        if (this.state.cycle_id) {
          await stateManager.saveTrade({
            cycle_id: this.state.cycle_id,
            symbol: SYMBOL,
            side: this.state.active_side || 'BOTH',
            entry_price: this.state.entry_price || 0,
            exit_price: parseFloat(order.averagePrice || order.price || '0'),
            pnl: finalPnl,
            realized_pnl: finalPnl
          });
        }

        // Clean up remaining orders — must cancel BOTH regular and algo orders
        // (if TP hit, SL algo order is still open; if SL hit, TP limit is still open)
        await cancelAllOrders();
        logger.info('[WS] Cleaned up remaining exit orders.');

        // Reset to IDLE for next cycle
        await stateManager.updatePhase('IDLE');

        // Immediately start the next cycle instead of waiting for the loop timer
        // Use a small delay to ensure state is fully updated and avoid race conditions
        logger.info('[WS] Starting next cycle after 1.5s...');
        setTimeout(() => {
          this.handleIdle().catch((e) =>
            logger.error('Error starting next cycle', { error: e })
          );
        }, 1500)
      }
    }
  },

  /**
   * Handle ALGO_UPDATE WebSocket events (for SL / conditional order status changes).
   * When the SL algo triggers, the actual fill comes via ORDER_TRADE_UPDATE for the
   * resulting market order. This handler is mainly for logging and edge-case recovery.
   */
  async handleAlgoUpdate(data: any) {
    const algo = data.algoOrder;
    logger.info('[WS] Algo Update', { symbol: algo.symbol, type: algo.orderType, status: algo.algoStatus, algoId: algo.algoId });

    if (algo.symbol !== SYMBOL) return;

    // If the algo order was unexpectedly canceled/rejected while in position, trigger a sync
    // BUT only if we're not already placing exits (prevents loops)
    if (algo.algoStatus === 'CANCELED' || algo.algoStatus === 'REJECTED' || algo.algoStatus === 'EXPIRED') {
      this.state = await stateManager.getState();
      if (this.state?.phase === 'IN_POSITION' && !this._placingExits) {
        logger.warn(`[WS] SL algo order ${algo.algoStatus} while in position! Syncing state...`);
        // Add a small delay to avoid immediate re-trigger
        setTimeout(async () => {
          const currentState = await stateManager.getState();
          if (currentState.phase === 'IN_POSITION' && !this._placingExits) {
            await this.syncStateWithBinance();
          }
        }, 1000);
      }
    }
    
    // When SL algo triggers (TRIGGERED/FINISHED), the actual fill comes via ORDER_TRADE_UPDATE
    // Just log it, don't do anything else - the position close will be handled by handleOrderUpdate
    if (algo.algoStatus === 'TRIGGERED' || algo.algoStatus === 'FINISHED') {
      logger.info(`[WS] SL algo order ${algo.algoStatus}, waiting for MARKET order fill...`);
    }
  },

  async handleIdle() {
    // Prevent concurrent execution
    if (this._placingOrders) {
      logger.warn('handleIdle already in progress, skipping duplicate call');
      return;
    }

    // Check state before proceeding
    this.state = await stateManager.getState();
    if (this.state.phase !== 'IDLE' || this.state.status === 'STOPPED') {
      logger.info('Not in IDLE phase or bot is stopped, skipping handleIdle', { phase: this.state.phase, status: this.state.status });
      return;
    }

    // Check for existing orders before placing new ones
    try {
      const existingOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      if (existingOrders.length > 0) {
        logger.warn(`Found ${existingOrders.length} existing orders, canceling before placing new ones`);
        await cancelAllOrders();
        // Wait a bit for cancellation to complete
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) {
      logger.error('Error checking existing orders', { error: e });
    }

    this._placingOrders = true;
    logger.info('Phase: IDLE. Starting new cycle...');
    try {
      // ── Cancel any stale orders from a previous cycle ───────────────────
      await cancelAllOrders();

      // ── Get current price ───────────────────────────────────────────────
      const priceRes = await client.getMarkPrice({ symbol: SYMBOL });
      const currentPrice = parseFloat(priceRes.markPrice as string);

      if (currentPrice <= 0) {
        logger.error(`Invalid mark price: ${currentPrice}. Skipping cycle.`);
        return;
      }

      const longEntryPrice = roundStep(currentPrice * (1 - ENTRY_OFFSET), this.tickSize);
      const shortEntryPrice = roundStep(currentPrice * (1 + ENTRY_OFFSET), this.tickSize);

      // ── Calculate position size from risk ───────────────────────────────
      const balance = await getAccountBalance();

      if (balance <= 0) {
        logger.error(`No available balance ($${balance}). Skipping cycle.`);
        return;
      }

      // Risk = 1% of balance, with buffer for fees/slippage
      const riskAmount = balance * RISK_PER_TRADE * RISK_BUFFER;

      let longQty = riskAmount / (longEntryPrice * STOP_LOSS_PERCENT);
      let shortQty = riskAmount / (shortEntryPrice * STOP_LOSS_PERCENT);

      longQty = floorStep(longQty, this.stepSize);
      shortQty = floorStep(shortQty, this.stepSize);

      // ── Validate quantities ─────────────────────────────────────────────
      if (longQty < this.minQty || shortQty < this.minQty) {
        logger.error(`Quantity below minimum (${this.minQty}). Long: ${longQty}, Short: ${shortQty}. Need more balance.`);
        return;
      }

      const longNotional = longQty * longEntryPrice;
      const shortNotional = shortQty * shortEntryPrice;

      if (longNotional < this.minNotional || shortNotional < this.minNotional) {
        logger.error(`Notional below minimum ($${this.minNotional}). Long: $${longNotional.toFixed(2)}, Short: $${shortNotional.toFixed(2)}. Need more balance.`);
        return;
      }

      logger.info('Placing straddle orders', {
        balance: balance.toFixed(2),
        risk: riskAmount.toFixed(2),
        riskPercent: (RISK_PER_TRADE * 100).toFixed(1),
        riskBuffer: RISK_BUFFER,
        longEntry: longEntryPrice,
        longQty: longQty,
        longNotional: longNotional.toFixed(2),
        shortEntry: shortEntryPrice,
        shortQty: shortQty,
        shortNotional: shortNotional.toFixed(2)
      });

      // ── Place both entry orders ─────────────────────────────────────────
      const longOrderParams: NewFuturesOrderParams = {
        symbol: SYMBOL,
        side: 'BUY',
        type: 'LIMIT',
        price: longEntryPrice,
        quantity: longQty,
        timeInForce: 'GTC'
      };

      const shortOrderParams: NewFuturesOrderParams = {
        symbol: SYMBOL,
        side: 'SELL',
        type: 'LIMIT',
        price: shortEntryPrice,
        quantity: shortQty,
        timeInForce: 'GTC'
      };

      const longOrder = await client.submitNewOrder(longOrderParams);
      const shortOrder = await client.submitNewOrder(shortOrderParams);

      const cycleId = randomUUID();
      await stateManager.updatePhase('WAITING_ENTRY', cycleId, {
        longOrderId: longOrder.orderId,
        shortOrderId: shortOrder.orderId
      });

      logger.info('Straddle placed', { cycleId, longOrderId: longOrder.orderId, shortOrderId: shortOrder.orderId });

    } catch (error) {
      logger.error('Error in handleIdle', { error });
    } finally {
      this._placingOrders = false;
    }
  },

  /**
   * Place Take-Profit and Stop-Loss exit orders.
   * - TP: regular LIMIT order (via submitNewOrder)
   * - SL: STOP_MARKET via Algo Order API (required since Binance Dec 2025 migration)
   */
  async placeExits(side: 'LONG' | 'SHORT', entryPrice: number, quantity: number) {
    // Prevent concurrent execution - SET LOCK FIRST
    if (this._placingExits) {
      logger.warn('placeExits already in progress, skipping duplicate call', { side, entryPrice, quantity });
      return;
    }
    
    // Set lock immediately to prevent race conditions
    this._placingExits = true;

    logger.info(`Placing exits for ${side} @ ${entryPrice} (Qty: ${quantity})`);

    if (entryPrice <= 0 || quantity <= 0) {
      logger.error(`Invalid exit params: entryPrice=${entryPrice}, quantity=${quantity}. Cannot place exits.`);
      this._placingExits = false;
      return;
    }

    // Check for existing exit orders before placing new ones
    try {
      const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      const openAlgoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
      
      const hasTP = openOrders.some(o => o.type === 'LIMIT' && o.reduceOnly);
      const hasSL = openAlgoOrders.some((o: any) => 
        o.orderType === 'STOP_MARKET' && 
        (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
      );
      
      if (hasTP && hasSL) {
        logger.warn('Exit orders already exist, skipping duplicate placement', { hasTP, hasSL, tpCount: openOrders.filter(o => o.type === 'LIMIT' && o.reduceOnly).length, slCount: openAlgoOrders.filter((o: any) => o.orderType === 'STOP_MARKET' && (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')).length });
        this._placingExits = false;
        return;
      }
      
      // If only one exists, just place the missing one (don't cancel the existing one)
      if (hasTP && !hasSL) {
        logger.info('TP exists but SL missing, will place SL only', { hasTP, hasSL });
      } else if (!hasTP && hasSL) {
        logger.info('SL exists but TP missing, will place TP only', { hasTP, hasSL });
      }
    } catch (e) {
      logger.error('Error checking existing exit orders', { error: e });
      this._placingExits = false;
      return;
    }

    // Verify we actually have a position before placing reduce-only orders
    let exitQty = quantity;
    try {
      const accInfo = await client.getAccountInformationV3();
      const position = accInfo.positions.find((p) => p.symbol === SYMBOL);
      const posAmt = position ? parseFloat(position.positionAmt as string) : 0;

      if (posAmt === 0) {
        logger.warn('Cannot place exit orders: No open position found', { side, entryPrice, quantity });
        this._placingExits = false;
        return;
      }

      // Verify position side matches
      const actualSide = posAmt > 0 ? 'LONG' : 'SHORT';
      if (actualSide !== side) {
        logger.warn('Position side mismatch', { expected: side, actual: actualSide, posAmt });
        this._placingExits = false;
        return;
      }

      // Use actual position size (may differ slightly due to partial fills)
      const actualQty = Math.abs(posAmt);
      if (actualQty < this.minQty) {
        logger.warn('Position size too small for exit orders', { actualQty, minQty: this.minQty });
        this._placingExits = false;
        return;
      }

      // Use the smaller of requested quantity or actual position size
      exitQty = Math.min(quantity, actualQty);
      logger.info('Verified position before placing exits', { side, posAmt, requestedQty: quantity, exitQty });

    } catch (e) {
      logger.error('Error verifying position before placing exits', { error: e });
      this._placingExits = false;
      return;
    }
    
    // Double-check for existing orders AFTER position verification (orders might have been placed by another thread)
    try {
      const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      const openAlgoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
      
      const hasTP = openOrders.some(o => o.type === 'LIMIT' && o.reduceOnly);
      const hasSL = openAlgoOrders.some((o: any) => 
        o.orderType === 'STOP_MARKET' && 
        (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
      );
      
      if (hasTP && hasSL) {
        logger.warn('Exit orders appeared while verifying position, skipping placement', { hasTP, hasSL });
        this._placingExits = false;
        return;
      }
    } catch (e) {
      logger.error('Error in final order check', { error: e });
      // Continue anyway - better to place than miss
    }

    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

    const tpPrice = side === 'LONG'
      ? roundStep(entryPrice * (1 + TAKE_PROFIT_PERCENT), this.tickSize)
      : roundStep(entryPrice * (1 - TAKE_PROFIT_PERCENT), this.tickSize);

    const slPrice = side === 'LONG'
      ? roundStep(entryPrice * (1 - STOP_LOSS_PERCENT), this.tickSize)
      : roundStep(entryPrice * (1 + STOP_LOSS_PERCENT), this.tickSize);

    // ── Place Take-Profit (regular LIMIT order) ───────────────────────────
    // Check if TP already exists before placing
    try {
      const openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      const tpOrders = openOrders.filter(o => o.type === 'LIMIT' && o.reduceOnly);
      const hasTP = tpOrders.length > 0;
      
      if (!hasTP) {
        await client.submitNewOrder({
          symbol: SYMBOL,
          side: closeSide,
          type: 'LIMIT',
          price: tpPrice,
          quantity: exitQty,
          timeInForce: 'GTC',
          reduceOnly: 'true'
        });
        logger.info(`TP placed: ${closeSide} LIMIT @ ${tpPrice} (Qty: ${exitQty})`);
      } else {
        logger.warn(`TP order already exists (${tpOrders.length} found), skipping placement`, { existingTPs: tpOrders.map(o => ({ orderId: o.orderId, price: o.price })) });
      }
    } catch (e: any) {
      logger.error('FAILED to place TP order', { error: e?.message || e, side, tpPrice, quantity: exitQty });
    }

    // ── Place Stop-Loss (Algo Order API — STOP_MARKET) ────────────────────
    // Check if SL already exists before placing
    try {
      const openAlgoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
      const slOrders = openAlgoOrders.filter((o: any) => 
        o.orderType === 'STOP_MARKET' && 
        (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
      );
      const hasSL = slOrders.length > 0;
      
      if (!hasSL) {
        const algoRes = await client.submitNewAlgoOrder({
          algoType: 'CONDITIONAL',
          symbol: SYMBOL,
          side: closeSide,
          type: 'STOP_MARKET',
          quantity: exitQty,
          triggerPrice: slPrice,
          reduceOnly: 'true',
        });
        logger.info(`SL placed: ${closeSide} STOP_MARKET (algo) @ ${slPrice} (Qty: ${exitQty})`, { algoId: algoRes.algoId });
      } else {
        logger.warn(`SL algo order already exists (${slOrders.length} found), skipping placement`, { existingSLs: slOrders.map((o: any) => ({ algoId: o.algoId, triggerPrice: o.triggerPrice, status: o.algoStatus })) });
      }
    } catch (e: any) {
      logger.error('FAILED to place SL algo order', { error: e?.message || e });
    } finally {
      this._placingExits = false;
      
      // Final verification: log all exit orders after placement
      try {
        const finalOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
        const finalAlgoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
        const finalTPs = finalOrders.filter(o => o.type === 'LIMIT' && o.reduceOnly);
        const finalSLs = finalAlgoOrders.filter((o: any) => 
          o.orderType === 'STOP_MARKET' && 
          (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
        );
        logger.info('Final exit order count after placement', { tpCount: finalTPs.length, slCount: finalSLs.length, totalExitOrders: finalTPs.length + finalSLs.length });
        
        if (finalTPs.length > 1 || finalSLs.length > 1) {
          logger.error('DUPLICATE EXIT ORDERS DETECTED!', { 
            tpCount: finalTPs.length, 
            slCount: finalSLs.length,
            tpOrders: finalTPs.map(o => ({ orderId: o.orderId, price: o.price })),
            slOrders: finalSLs.map((o: any) => ({ algoId: o.algoId, triggerPrice: o.triggerPrice }))
          });
        }
      } catch (e) {
        logger.error('Error in final order verification', { error: e });
      }
    }
  }
};

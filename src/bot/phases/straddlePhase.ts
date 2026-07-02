import {
  ACCOUNT_RISK_PERCENT,
  BUCKET_SIZE,
  LADDER_LEVELS,
  LADDER_SIZE_MULT,
  SYMBOL,
  WALLS_TO_KEEP,
} from '../config';
import { client } from '../client';
import { getAccountBalance } from '../exchange';
import { planLadderPricesFromWalls } from '../ladder/projection';
import {
  computeBaseQty,
  computeRiskAmount,
  formatLadderSizingError,
  resolveBaseQtyForLadder,
  validateLadderWithSlGeometry,
} from '../ladder/sizing';
import { roundStep } from '../math';
import { orderBookCollector, Wall } from '../orderbook';
import { stateManager } from '../state';
import { LadderState, SymbolPrecision } from '../types';
import { logger } from '../../utils/logger';

export interface StraddlePlacementResult {
  ladder: LadderState;
}

export async function placeStraddleOrders(
  precision: SymbolPrecision
): Promise<StraddlePlacementResult | null> {
  const state = await stateManager.getState();
  if (state.status !== 'RUNNING' || state.phase !== 'COLLECTING') {
    logger.info('[Straddle] Skipping placement', { status: state.status, phase: state.phase });
    return null;
  }

  const snap = orderBookCollector.getWalls(BUCKET_SIZE, WALLS_TO_KEEP);

  let price = snap.currentPrice;
  if (!price) {
    const priceRes = await client.getMarkPrice({ symbol: SYMBOL });
    price = parseFloat((priceRes as { markPrice: string }).markPrice);
  }

  if (!price || snap.buyWalls.length === 0 || snap.sellWalls.length === 0) {
    logger.error('[Straddle] Order book snapshot incomplete', {
      price,
      buyWalls: snap.buyWalls.length,
      sellWalls: snap.sellWalls.length,
    });
    return null;
  }

  const balance = await getAccountBalance();
  if (balance <= 0) {
    logger.error(`[Straddle] No available balance ($${balance}).`);
    return null;
  }

  const riskAmount = computeRiskAmount(balance, ACCOUNT_RISK_PERCENT);
  const notionalCap = computeBaseQty(balance, price, precision.stepSize);

  const sortByDistance = (walls: Wall[]) =>
    [...walls].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));

  const buyLadder = sortByDistance(snap.buyWalls);
  const sellLadder = sortByDistance(snap.sellWalls);

  const buyPrice = roundStep(buyLadder[0].price, precision.tickSize);
  const sellPrice = roundStep(sellLadder[0].price, precision.tickSize);

  const longPrices = planLadderPricesFromWalls(
    buyLadder,
    'LONG',
    buyPrice,
    LADDER_LEVELS,
    precision.tickSize
  );
  const shortPrices = planLadderPricesFromWalls(
    sellLadder,
    'SHORT',
    sellPrice,
    LADDER_LEVELS,
    precision.tickSize
  );

  if (longPrices.length < LADDER_LEVELS || shortPrices.length < LADDER_LEVELS) {
    logger.error('[Straddle] Aborting — could not plan full ladder prices', {
      levels: LADDER_LEVELS,
      longPrices,
      shortPrices,
    });
    return null;
  }

  const resolved = resolveBaseQtyForLadder(
    shortPrices,
    longPrices,
    riskAmount,
    precision.stepSize,
    precision.minQty,
    precision.minNotional,
    precision.tickSize,
    LADDER_SIZE_MULT,
    notionalCap,
    LADDER_LEVELS
  );

  if (!resolved) {
    const longV = validateLadderWithSlGeometry(
      longPrices,
      'LONG',
      notionalCap,
      riskAmount,
      precision.stepSize,
      precision.minQty,
      precision.minNotional,
      precision.tickSize,
      LADDER_SIZE_MULT
    );
    const shortV = validateLadderWithSlGeometry(
      shortPrices,
      'SHORT',
      notionalCap,
      riskAmount,
      precision.stepSize,
      precision.minQty,
      precision.minNotional,
      precision.tickSize,
      LADDER_SIZE_MULT
    );
    logger.error(
      '[Straddle] Aborting — cannot place full ladder + SL on both sides (no orders sent)',
      {
        levels: LADDER_LEVELS,
        riskAmount: riskAmount.toFixed(2),
        capQty: notionalCap,
        long: {
          prices: longPrices,
          error: formatLadderSizingError(longV, LADDER_LEVELS),
        },
        short: {
          prices: shortPrices,
          error: formatLadderSizingError(shortV, LADDER_LEVELS),
        },
      }
    );
    return null;
  }

  const { baseQty, shortQtys, longQtys } = resolved;

  if (baseQty < precision.minQty || baseQty * price < precision.minNotional) {
    logger.error('[Straddle] Aborting — base qty too small (no orders sent)', {
      qty: baseQty,
      notional: (baseQty * price).toFixed(2),
    });
    return null;
  }

  logger.info('[Straddle] Pre-flight OK — full ladder + SL feasible on both sides', {
    levels: LADDER_LEVELS,
    currentPrice: price,
    long: { prices: longPrices, quantities: longQtys },
    short: { prices: shortPrices, quantities: shortQtys },
    baseQty,
    riskAmount: riskAmount.toFixed(2),
  });

  const buyOrder = await client.submitNewOrder({
    symbol: SYMBOL,
    side: 'BUY',
    type: 'LIMIT',
    price: buyPrice,
    quantity: baseQty,
    timeInForce: 'GTC',
  });
  const sellOrder = await client.submitNewOrder({
    symbol: SYMBOL,
    side: 'SELL',
    type: 'LIMIT',
    price: sellPrice,
    quantity: baseQty,
    timeInForce: 'GTC',
  });

  const ladder: LadderState = {
    baseQty,
    riskAmount,
    buyWalls: snap.buyWalls,
    sellWalls: snap.sellWalls,
    usedWalls: [buyPrice, sellPrice],
    side: null,
    entryOrders: [
      { clientOrderId: buyOrder.clientOrderId, side: 'BUY', price: buyPrice, qty: baseQty, status: 'OPEN' },
      { clientOrderId: sellOrder.clientOrderId, side: 'SELL', price: sellPrice, qty: baseQty, status: 'OPEN' },
    ],
    fills: 0,
    partialCloses: 0,
    feesPaid: 0,
    entryPrice: 0,
    posQty: 0,
    slAlgoId: null,
    tpClientOrderId: null,
    windingDown: false,
    ladderStep: 0,
    ladderLevels: LADDER_LEVELS,
  };

  logger.info('[Straddle] Initial straddle placed', {
    buyClientOrderId: buyOrder.clientOrderId,
    sellClientOrderId: sellOrder.clientOrderId,
  });

  return { ladder };
}

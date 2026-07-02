import { LADDER_LEVELS, TP_REWARD_RATIO } from '../config';
import { effectiveLadderLevels, isLadderFullyPlaced } from '../ladder/coverage';
import { buildingSlPrice } from '../ladder/sizing';
import {
  projectFullLadder,
  hasFullLadderProjection,
  projectPlannedLadder,
} from '../ladder/projection';
import { LadderState, SymbolPrecision } from '../types';
import { BotPhase } from '../state';
import { computeExitPrices, ExitPriceOptions } from './exitPricing';
import { isHarvestMode } from './harvestMode';

export function buildExitPriceOptions(
  ladder: LadderState,
  precision: SymbolPrecision,
  harvestMode: boolean,
  currentPrice: number,
  _exchangeEntryCount?: number
): ExitPriceOptions {
  const options: ExitPriceOptions = { harvestMode, currentPrice };

  if (!harvestMode && ladder.side) {
    const levels = effectiveLadderLevels(ladder);

    // Ladder cannot extend — protect open position with risk-sized SL on current qty.
    if (ladder.ladderSizingBlocked) {
      return options;
    }

    let projection = null;
    if (hasFullLadderProjection(ladder, levels)) {
      projection = projectFullLadder(ladder, levels, precision.stepSize);
    } else {
      projection = projectPlannedLadder(
        ladder,
        precision.stepSize,
        precision.tickSize,
        precision.minQty,
        precision.minNotional,
        levels
      );
    }

    if (projection) {
      const prices = projection.levels.map((l) => l.price);
      const quantities = projection.levels.map((l) => l.qty);
      const slValid =
        buildingSlPrice(quantities, prices, ladder.side, ladder.riskAmount, precision.tickSize) !==
        null;

      if (slValid) {
        options.buildingSlProjection = {
          avgEntry: projection.avgEntry,
          qty: projection.totalQty,
          deepestPrice: projection.deepestPrice,
          prices,
          quantities,
        };
        if (!isLadderFullyPlaced(ladder, levels)) {
          options.deferBuildingSl = true;
        }
      }
    } else if (!isLadderFullyPlaced(ladder, levels)) {
      options.deferBuildingSl = true;
    }
  }

  return options;
}

export function computeLadderExitPrices(
  ladder: LadderState,
  precision: SymbolPrecision,
  currentPrice = 0,
  botPhase?: BotPhase,
  exchangeEntryCount?: number
) {
  const harvestMode = isHarvestMode(ladder, botPhase);
  const options = buildExitPriceOptions(
    ladder,
    precision,
    harvestMode,
    currentPrice,
    exchangeEntryCount
  );
  return computeExitPrices(
    ladder.side!,
    ladder.entryPrice,
    ladder.posQty,
    ladder.riskAmount,
    precision.tickSize,
    TP_REWARD_RATIO,
    options
  );
}

/** For /status — uses ladder snapshot without exchange round-trip. */
export function computeLadderExitPricesFromState(
  ladder: LadderState,
  tickSize: number,
  currentPrice = 0
) {
  return computeLadderExitPrices(
    ladder,
    { tickSize, stepSize: 0.001, minQty: 0.001, minNotional: 0 },
    currentPrice
  );
}

import { MainClient } from 'binance';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set in .env');
}

/** Spot REST client (same API keys; spot trading must be enabled on the key). */
export const spotClient = new MainClient({
  api_key: API_KEY,
  api_secret: API_SECRET,
  disableTimeSync: false,
});

export async function getSpotAssetBalance(asset: string): Promise<number> {
  const info = await spotClient.getAccountInformation();
  const row = info.balances.find((b) => b.asset === asset);
  if (!row) return 0;
  return parseFloat(row.free as string) + parseFloat(row.locked as string);
}

export async function fetchSpotSymbolPrecision(symbol: string): Promise<{
  stepSize: number;
  minQty: number;
  minNotional: number;
}> {
  const defaults = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  try {
    const info = await spotClient.getExchangeInfo({ symbol });
    const symbolInfo = info.symbols.find((s) => s.symbol === symbol);
    if (!symbolInfo) return defaults;
    const lot = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE') as
      | { stepSize: string; minQty: string }
      | undefined;
    const notional = symbolInfo.filters.find((f) => f.filterType === 'NOTIONAL') as
      | { minNotional?: string }
      | undefined;
    return {
      stepSize: lot ? parseFloat(lot.stepSize) : defaults.stepSize,
      minQty: lot ? parseFloat(lot.minQty) : defaults.minQty,
      minNotional: notional?.minNotional ? parseFloat(notional.minNotional) : defaults.minNotional,
    };
  } catch (e) {
    logger.error('[Spot] Failed to fetch exchange info', { error: e });
    return defaults;
  }
}

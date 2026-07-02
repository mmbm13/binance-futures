import { USDMClient } from 'binance';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const USE_TESTNET = process.env.USE_TESTNET === 'true';

if (!API_KEY || !API_SECRET) {
  throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set in .env');
}

logger.info(`Initializing Binance USDM Futures Client (Testnet: ${USE_TESTNET})`);

export const client = new USDMClient({
  api_key: API_KEY,
  api_secret: API_SECRET,
  testnet: USE_TESTNET,
  disableTimeSync: false
});

export const checkConnection = async () => {
  try {
    const time = await client.getServerTime();
    logger.info(`Connected to Binance Futures. Server time: ${time}`);
    return true;
  } catch (error) {
    logger.error('Failed to connect to Binance Futures', { error });
    return false;
  }
};

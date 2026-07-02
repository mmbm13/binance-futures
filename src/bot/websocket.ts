
import { WebsocketClient } from 'binance';
import { botEngine } from './engine';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const USE_TESTNET = process.env.USE_TESTNET === 'true';

// WebSocket Client Configuration
const wsClient = new WebsocketClient({
  api_key: API_KEY,
  api_secret: API_SECRET,
  beautify: true,
  demoTrading: USE_TESTNET
});

// Guard to prevent duplicate listeners
let wsStarted = false;
// Store handler references so we can remove them
let formattedMessageHandler: ((data: any) => Promise<void>) | null = null;
let openHandler: ((data: any) => void) | null = null;
let exceptionHandler: ((data: any) => void) | null = null;
let reconnectingHandler: ((data: any) => void) | null = null;
let reconnectedHandler: ((data: any) => Promise<void>) | null = null;

export const wsManager = {
  start: async () => {
    if (wsStarted) {
      logger.warn('[WS] wsManager.start called but WS is already started. Ignoring duplicate call.');
      return;
    }
    wsStarted = true;

    logger.info(`[WS] Starting WebSocket Listener (testnet: ${USE_TESTNET})...`);

    // Remove all existing listeners first to prevent duplicates
    wsClient.removeAllListeners('open');
    wsClient.removeAllListeners('exception');
    wsClient.removeAllListeners('reconnecting');
    wsClient.removeAllListeners('reconnected');
    wsClient.removeAllListeners('formattedMessage');

    // Connection opened
    openHandler = (data: any) => {
      logger.info('[WS] Connection opened', { wsKey: data.wsKey, url: data.ws.url });
    };
    wsClient.on('open', openHandler);

    // Handle exceptions — 'error' is deprecated in this SDK version, use 'exception' instead
    exceptionHandler = (data: any) => {
      logger.error('[WS] Exception', { wsKey: data.wsKey, data });
    };
    wsClient.on('exception', exceptionHandler);

    // Handle reconnecting (built-in to the binance package)
    reconnectingHandler = (data: any) => {
      logger.warn('[WS] Reconnecting', { wsKey: data?.wsKey });
    };
    wsClient.on('reconnecting', reconnectingHandler);

    // Handle reconnected
    reconnectedHandler = async (data: any) => {
      logger.info('[WS] Reconnected', { wsKey: data?.wsKey });
      // Sync state after reconnection to ensure consistency
      try {
        await botEngine.syncStateWithBinance();
        logger.info('[WS] State synced after reconnection.');
      } catch (e) {
        logger.error('[WS] Error syncing state after reconnection', { error: e });
      }
    };
    wsClient.on('reconnected', reconnectedHandler);

    // Handle formatted messages
    formattedMessageHandler = async (data: any) => {
      if (Array.isArray(data)) {
        return;
      }

      // Handle regular Order Update (ORDER_TRADE_UPDATE)
      if (data.eventType === 'ORDER_TRADE_UPDATE') {
        const order = data.order as any;
        logger.info('[WS] Order Update format message', {
          symbol: order.symbol,
          side: order.side,
          status: order.orderStatus,
          type: order.orderType,
          clientOrderId: order.clientOrderId,
        });

        try {
          await botEngine.handleOrderUpdate(data);
        } catch (e) {
          logger.error('[WS] Error handling order update', { error: e });
        }
      }

      // Handle Algo Order Update (ALGO_UPDATE) — SL orders use Algo API since Dec 2025
      if (data.eventType === 'ALGO_UPDATE') {
        const algo = (data as any).algoOrder;
        logger.info('[WS] Algo Update', { symbol: algo.symbol, type: algo.orderType, status: algo.algoStatus, algoId: algo.algoId });

        try {
          await botEngine.handleAlgoUpdate(data);
        } catch (e) {
          logger.error('[WS] Error handling algo update', { error: e });
        }
      }
    };
    wsClient.on('formattedMessage', formattedMessageHandler);

    // Subscribe to User Data Stream for Order Updates
    // This handles listenKey generation and keep-alive automatically
    wsClient.subscribeUsdFuturesUserDataStream();

    logger.info('[WS] Subscribed to User Data Stream.');
  },

  close: () => {
    try {
      // Remove all listeners before closing
      if (formattedMessageHandler) {
        wsClient.removeListener('formattedMessage', formattedMessageHandler);
        formattedMessageHandler = null;
      }
      if (openHandler) {
        wsClient.removeListener('open', openHandler);
        openHandler = null;
      }
      if (exceptionHandler) {
        wsClient.removeListener('exception', exceptionHandler);
        exceptionHandler = null;
      }
      if (reconnectingHandler) {
        wsClient.removeListener('reconnecting', reconnectingHandler);
        reconnectingHandler = null;
      }
      if (reconnectedHandler) {
        wsClient.removeListener('reconnected', reconnectedHandler);
        reconnectedHandler = null;
      }
      
      wsClient.closeAll();
      wsStarted = false;
      logger.info('[WS] All connections closed and listeners removed.');
    } catch (e) {
      logger.error('[WS] Error closing connections', { error: e });
    }
  }
};

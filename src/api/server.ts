import Fastify from 'fastify';
import { botEngine } from '../bot/engine';
import { db } from '../db';
import * as dotenv from 'dotenv';
import { stateManager } from '../bot/state';
import { wsManager } from '../bot/websocket';
import { client } from '../bot/client';
import { logger } from '../utils/logger';

dotenv.config();

const SYMBOL = 'ETHUSDT';
const fastify = Fastify({ logger: true });

// Start Bot
fastify.post('/start', async (_request, reply) => {
  const state = await stateManager.getState();
  if (state.status === 'RUNNING') {
    return reply.code(200).send({ status: 'already_running', phase: state.phase });
  }
  await stateManager.updateStatus('RUNNING');
  // If the engine wasn't initialized yet (e.g. first start), init it
  if (!botEngine.initialized) {
    await botEngine.init();
    await wsManager.start();
  } else {
    // If already initialized, sync state with Binance
    // This will trigger handleIdle() if in IDLE state with no orders
    await botEngine.syncStateWithBinance();
  }
  return { status: 'started' };
});

// Stop Bot — cancels all open orders for safety
fastify.post('/stop', async (_request, reply) => {
  await stateManager.updateStatus('STOPPED');

  // Cancel all open orders (regular + algo) to prevent orphaned orders
  try {
    await client.cancelAllOpenOrders({ symbol: SYMBOL });
  } catch (_) { /* no regular orders is fine */ }
  try {
    await client.cancelAllAlgoOpenOrders({ symbol: SYMBOL });
  } catch (_) { /* no algo orders is fine */ }
  fastify.log.info('Canceled all open orders (regular + algo) on stop.');

  return { status: 'stopped', message: 'Bot stopped and open orders canceled.' };
});

// Get Status
fastify.get('/status', async (_request, _reply) => {
  const state = await stateManager.getState();
  const recentTradesRes = await db.query('SELECT * FROM trades ORDER BY closed_at DESC LIMIT 5');
  return {
    state,
    recentTrades: recentTradesRes.rows
  };
});

// Get History
fastify.get('/history', async (_request, _reply) => {
  const res = await db.query('SELECT * FROM trades ORDER BY closed_at DESC LIMIT 100');
  return res.rows;
});

// ─── Startup ─────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });

    // Initialize bot engine and WebSocket (awaited for proper error propagation)
    await botEngine.init();
    await wsManager.start();

    fastify.log.info('Bot engine and WebSocket initialized.');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    wsManager.close();
    await fastify.close();
    await db.end();
    logger.info('Shutdown complete.');
    process.exit(0);
  } catch (e) {
    logger.error('Error during shutdown', { error: e });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();

import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { botEngine, SYMBOL } from '../bot/engine';
import { db } from '../db';
import * as dotenv from 'dotenv';
import { stateManager } from '../bot/state';
import { wsManager } from '../bot/websocket';
import { client } from '../bot/client';
import { logger } from '../utils/logger';
import {
  buildCycleMetrics,
  computeTradeMetrics,
  fetchAllTrades,
  fetchRecentTrades,
} from '../bot/metrics';
import { requireApiKey } from './auth';
import {
  getLogFilePath,
  getLogFileStats,
  readLogTail,
  readLogTailAsText,
  resolveLogFile,
} from './logReader';

dotenv.config();

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
    // If already initialized, sync state with Binance.
    // This starts a fresh cycle (order book collection) when flat.
    await botEngine.syncStateWithBinance();
  }
  return { status: 'started' };
});

// Stop Bot — stops collection timers/streams and cancels all open orders
fastify.post('/stop', async (_request, reply) => {
  await stateManager.updateStatus('STOPPED');

  // Stop order book collection / timers
  await botEngine.stop();

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
  const allTrades = await fetchAllTrades(db);
  const recentTrades = await fetchRecentTrades(db, 5);

  return {
    state,
    cycle: buildCycleMetrics(state, botEngine.ladder, botEngine.tickSize),
    performance: computeTradeMetrics(allTrades),
    recentTrades,
  };
});

// Get History
fastify.get('/history', async (_request, _reply) => {
  const res = await db.query('SELECT * FROM trades ORDER BY closed_at DESC LIMIT 100');
  return res.rows;
});

// ─── Logs (remote access without SSH) ───────────────────────────────────────
fastify.get('/logs', async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const q = request.query as {
    lines?: string;
    file?: string;
    level?: string;
    search?: string;
    format?: string;
  };

  const file = resolveLogFile(q.file);
  const lines = q.lines ? Number(q.lines) : 200;
  const opts = { file, lines, level: q.level, search: q.search };

  if (q.format === 'text') {
    reply.type('text/plain; charset=utf-8');
    return readLogTailAsText(opts);
  }

  const result = readLogTail(opts);
  return {
    file: result.file,
    returned: result.entries.length,
    totalInFile: result.total,
    stats: getLogFileStats(file),
    entries: result.entries,
  };
});

fastify.get('/logs/download', async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const file = resolveLogFile((request.query as { file?: string }).file);
  const filePath = getLogFilePath(file);
  if (!getLogFileStats(file).exists) {
    return reply.code(404).send({ error: 'Log file not found' });
  }

  return reply
    .header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`)
    .type('text/plain')
    .send(fs.readFileSync(filePath, 'utf8'));
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

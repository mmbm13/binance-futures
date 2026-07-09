import '../config/env'; // MUST be first: layers .env.<strategy> over .env
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import * as dotenv from 'dotenv';
import { stateManager } from '../bot/state';
import { wsManager } from '../bot/websocket';
import { logger } from '../utils/logger';
import {
  computeTradeMetrics,
  fetchAllTrades,
  fetchRecentTrades,
} from '../bot/metrics';
import { buildComparison } from '../bot/compareMetrics';
import { getActiveStrategy, STRATEGY_ID, EXECUTION_MODE } from '../strategies/registry';
import { startEquitySnapshots, stopEquitySnapshots } from '../monitor/equity';
import { requireApiKey } from './auth';
import {
  getLogFilePath,
  getLogFileStats,
  readLogs,
  readLogTailAsText,
  resolveLogFile,
  resolveLogOrder,
} from './logReader';

dotenv.config();

const fastify = Fastify({ logger: true });

// Start Bot — always invokes strategy.start() so multiple paper processes can boot independently
fastify.post('/start', async (_request, reply) => {
  const state = await stateManager.getState();
  const wasRunning = state.status === 'RUNNING';
  if (!wasRunning) {
    await stateManager.updateStatus('RUNNING');
  }
  await getActiveStrategy().start();
  return reply.code(200).send({
    status: 'started',
    strategy: STRATEGY_ID,
    wasAlreadyRunning: wasRunning,
  });
});

// Stop Bot — local strategy only; in paper mode keep global RUNNING for sibling processes
fastify.post('/stop', async (_request, _reply) => {
  await getActiveStrategy().stop();
  if (EXECUTION_MODE !== 'paper') {
    await stateManager.updateStatus('STOPPED');
  }
  return {
    status: 'stopped',
    strategy: STRATEGY_ID,
    message:
      EXECUTION_MODE === 'paper'
        ? 'Strategy stopped locally (global RUNNING preserved for other paper bots).'
        : 'Bot stopped and open orders canceled.',
  };
});

// Get Status
fastify.get('/status', async (_request, _reply) => {
  const state = await stateManager.getState();
  const allTrades = await fetchAllTrades(db);
  const recentTrades = await fetchRecentTrades(db, 5);

  return {
    strategy: STRATEGY_ID,
    executionMode: EXECUTION_MODE,
    state,
    cycle: await getActiveStrategy().getMetrics(),
    performance: computeTradeMetrics(allTrades),
    recentTrades,
  };
});

// Per-strategy comparison table (expectancy, profit factor, drawdown, Sharpe, fees)
fastify.get('/compare', async (_request, _reply) => {
  return buildComparison(db);
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
    from?: string;
    to?: string;
    order?: string;
    format?: string;
  };

  const file = resolveLogFile(q.file);
  const order = resolveLogOrder(q.order);
  const lines = q.lines ? Number(q.lines) : 200;

  try {
    const opts = {
      file,
      lines: Number.isFinite(lines) ? lines : 200,
      level: q.level,
      search: q.search,
      from: q.from,
      to: q.to,
      order,
    };

    if (q.format === 'text') {
      reply.type('text/plain; charset=utf-8');
      return readLogTailAsText(opts);
    }

    const result = readLogs(opts);
    return {
      file: result.file,
      order: result.order,
      filters: result.filters,
      returned: result.entries.length,
      totalMatching: result.total,
      stats: getLogFileStats(file),
      entries: result.entries,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(400).send({ error: msg });
  }
});

fastify.get('/logs/download', async (request, reply) => {
  if (!requireApiKey(request, reply)) return;

  const q = request.query as {
    file?: string;
    from?: string;
    to?: string;
    order?: string;
    level?: string;
    search?: string;
  };

  const file = resolveLogFile(q.file);
  const filePath = getLogFilePath(file);
  if (!getLogFileStats(file).exists) {
    return reply.code(404).send({ error: 'Log file not found' });
  }

  const hasFilters = q.from || q.to || q.level || q.search || q.order === 'asc';

  try {
    if (hasFilters) {
      const text = readLogTailAsText({
        file,
        from: q.from,
        to: q.to,
        order: resolveLogOrder(q.order),
        level: q.level,
        search: q.search,
      });
      const suffix = q.from || q.to ? '-filtered' : '';
      return reply
        .header('Content-Disposition', `attachment; filename="${path.basename(filePath, '.log')}${suffix}.log"`)
        .type('text/plain; charset=utf-8')
        .send(text);
    }

    return reply
      .header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`)
      .type('text/plain')
      .send(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(400).send({ error: msg });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });

    // Initialize the active strategy and the user-data WebSocket
    const strategy = getActiveStrategy();
    await strategy.init();
    await wsManager.start();
    startEquitySnapshots(STRATEGY_ID);

    fastify.log.info(`Strategy "${STRATEGY_ID}" (${EXECUTION_MODE}) and WebSocket initialized.`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    stopEquitySnapshots();
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

import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { LadderStrategy } from './ladder';
import { MomentumStrategy } from './momentum';
import { FundingStrategy } from './funding';
import { BounceStrategy } from './bounce';
import { LiqRevStrategy } from './liqrev';
import { ExecutionMode, Strategy, StrategyId } from './types';

dotenv.config();

const VALID_IDS: StrategyId[] = ['ladder', 'funding', 'momentum', 'liqrev', 'bounce'];

export function resolveStrategyId(raw: string | undefined): StrategyId {
  const id = (raw || 'ladder').toLowerCase() as StrategyId;
  if (!VALID_IDS.includes(id)) {
    throw new Error(`Unknown STRATEGY "${raw}". Valid: ${VALID_IDS.join(', ')}`);
  }
  return id;
}

export function resolveExecutionMode(raw: string | undefined): ExecutionMode {
  const mode = (raw || 'live').toLowerCase();
  if (mode !== 'live' && mode !== 'paper') {
    throw new Error(`Unknown EXECUTION_MODE "${raw}". Valid: live, paper`);
  }
  return mode;
}

export const STRATEGY_ID: StrategyId = resolveStrategyId(process.env.STRATEGY);
export const EXECUTION_MODE: ExecutionMode = resolveExecutionMode(process.env.EXECUTION_MODE);

let active: Strategy | null = null;

function buildStrategy(id: StrategyId): Strategy {
  switch (id) {
    case 'ladder':
      if (EXECUTION_MODE === 'paper') {
        // The ladder engine talks to the exchange client directly; use USE_TESTNET=true
        // as its paper environment until it is ported to the Executor abstraction.
        throw new Error('EXECUTION_MODE=paper is not supported for STRATEGY=ladder (use USE_TESTNET=true)');
      }
      return new LadderStrategy();
    case 'momentum':
      return new MomentumStrategy(EXECUTION_MODE);
    case 'funding':
      return new FundingStrategy(EXECUTION_MODE);
    case 'bounce':
      return new BounceStrategy(EXECUTION_MODE);
    case 'liqrev':
      return new LiqRevStrategy(EXECUTION_MODE);
    default:
      throw new Error(`Strategy "${id}" is not implemented yet`);
  }
}

export function getActiveStrategy(): Strategy {
  if (!active) {
    active = buildStrategy(STRATEGY_ID);
    logger.info(`[Registry] Active strategy: ${active.id} (execution: ${EXECUTION_MODE})`);
  }
  return active;
}

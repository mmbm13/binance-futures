import { EXECUTION_MODE } from '../strategies/registry';
import { LiveExecutor } from './live';
import { PaperExecutor } from './paper';
import { Executor } from './types';

export * from './types';
export { LiveExecutor } from './live';
export { PaperExecutor } from './paper';
export type { PaperQuote, PaperState } from './paper';

/** Build the executor for the configured EXECUTION_MODE. */
export function createExecutor(symbol: string): Executor {
  if (EXECUTION_MODE === 'paper') {
    return new PaperExecutor({ symbol });
  }
  return new LiveExecutor(symbol);
}

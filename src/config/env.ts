/**
 * Layered env loading. Priority (highest wins):
 *   1. Real environment variables (CLI / systemd / docker)
 *   2. .env.<strategy>  (per-strategy overlay, e.g. .env.momentum)
 *   3. .env             (shared base: DB, API keys, symbol, fees)
 *
 * MUST be the first import of the entry point so that config modules
 * (src/bot/config.ts, src/strategies/x/config.ts) read the merged result.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Keys set before any .env file are CLI/system-provided → never overridden.
const cliKeys = new Set(Object.keys(process.env));

dotenv.config(); // base .env (does not override existing vars)

const strategy = (process.env.STRATEGY || 'ladder').toLowerCase();
const overlayPath = path.resolve(process.cwd(), `.env.${strategy}`);

let overlayApplied = false;
if (fs.existsSync(overlayPath)) {
  const parsed = dotenv.parse(fs.readFileSync(overlayPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!cliKeys.has(key)) process.env[key] = value;
  }
  overlayApplied = true;
  console.log(`[env] Loaded overlay ${path.basename(overlayPath)} over .env (CLI vars win)`);
}

export const ENV_INFO = {
  strategy,
  overlayFile: overlayApplied ? `.env.${strategy}` : null,
};

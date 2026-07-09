import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    await client.connect();

    // Add current_pnl column if it doesn't exist
    await client.query(`
      ALTER TABLE bot_state
      ADD COLUMN IF NOT EXISTS current_pnl DECIMAL DEFAULT 0;
    `);

    // Add entry_price column if it doesn't exist
    await client.query(`
      ALTER TABLE bot_state
      ADD COLUMN IF NOT EXISTS entry_price DECIMAL DEFAULT 0;
    `);

    // Add active_side column if it doesn't exist
    await client.query(`
      ALTER TABLE bot_state
      ADD COLUMN IF NOT EXISTS active_side TEXT;
    `);

    // Strategy comparison columns on trades
    await client.query(`
      ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS strategy TEXT DEFAULT 'ladder',
      ADD COLUMN IF NOT EXISTS qty DECIMAL,
      ADD COLUMN IF NOT EXISTS fees DECIMAL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS funding DECIMAL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}';
    `);

    // Signals table (every evaluated setup, executed or not)
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        strategy TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        acted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_signals_strategy_created ON signals (strategy, created_at DESC);`
    );

    // Equity snapshots per strategy
    await client.query(`
      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id SERIAL PRIMARY KEY,
        strategy TEXT NOT NULL,
        balance DECIMAL NOT NULL,
        unrealized DECIMAL DEFAULT 0,
        taken_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_equity_strategy_taken ON equity_snapshots (strategy, taken_at DESC);`
    );

    console.log(
      'Migration completed: bot_state columns, trades strategy columns, signals & equity_snapshots tables'
    );
  } catch (err) {
    console.error('Error running migration:', err);
  } finally {
    await client.end();
  }
}

migrate();

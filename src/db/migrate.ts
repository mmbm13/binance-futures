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

    console.log('Migration completed: bot_state columns up to date (current_pnl, entry_price, active_side)');
  } catch (err) {
    console.error('Error running migration:', err);
  } finally {
    await client.end();
  }
}

migrate();

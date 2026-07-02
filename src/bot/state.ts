import { db } from '../db';

export type BotStatus = 'RUNNING' | 'STOPPED';
export type BotPhase =
  | 'IDLE'
  | 'COLLECTING'
  | 'WAITING_ENTRY'
  | 'BUILDING'
  | 'HARVESTING'
  | 'IN_POSITION'; // legacy alias treated as BUILDING

export interface BotState {
  status: BotStatus;
  phase: BotPhase;
  cycle_id: string | null;
  orders: Record<string, any>;
  current_pnl: number;
  entry_price: number;
  active_side: string | null;
}

export const stateManager = {
  async getState(): Promise<BotState> {
    const res = await db.query('SELECT * FROM bot_state WHERE id = 1');
    const row = res.rows[0];
    if (!row) {
      throw new Error('bot_state row not found. Run db:init first.');
    }
    return {
      status: row.status,
      phase: row.phase,
      cycle_id: row.cycle_id,
      orders: row.orders || {},
      current_pnl: parseFloat(row.current_pnl) || 0,
      entry_price: parseFloat(row.entry_price) || 0,
      active_side: row.active_side,
    } as BotState;
  },

  async updateStatus(status: BotStatus) {
    await db.query('UPDATE bot_state SET status = $1, updated_at = NOW() WHERE id = 1', [status]);
  },

  async updatePhase(
    phase: BotPhase,
    cycleId?: string | null,
    orders?: Record<string, any>,
    pnl?: number,
    entryPrice?: number,
    activeSide?: string | null
  ) {
    const updates: string[] = ['phase = $1'];
    const params: any[] = [phase];
    let idx = 2;

    if (cycleId !== undefined) {
      updates.push(`cycle_id = $${idx++}`);
      params.push(cycleId);
    }
    if (orders !== undefined) {
      // Ensure proper JSON serialization for JSONB column
      updates.push(`orders = $${idx++}`);
      params.push(JSON.stringify(orders));
    }
    if (entryPrice !== undefined) {
      updates.push(`entry_price = $${idx++}`);
      params.push(entryPrice);
    }
    if (activeSide !== undefined) {
      updates.push(`active_side = $${idx++}`);
      params.push(activeSide);
    }

    if (phase === 'IDLE') {
      // Reset cycle-specific fields when going back to IDLE
      updates.push(`current_pnl = 0`);
      updates.push(`entry_price = 0`);
      updates.push(`active_side = NULL`);
      updates.push(`orders = '{}'::jsonb`);
    } else if (pnl !== undefined) {
      updates.push(`current_pnl = COALESCE(current_pnl, 0) + $${idx++}`);
      params.push(pnl);
    }

    await db.query(
      `UPDATE bot_state SET ${updates.join(', ')}, updated_at = NOW() WHERE id = 1`,
      params
    );
  },

  async saveTrade(trade: {
    cycle_id: string;
    symbol: string;
    side: string;
    entry_price: number;
    exit_price?: number;
    pnl?: number;
    realized_pnl?: number;
  }) {
    await db.query(
      `INSERT INTO trades (cycle_id, symbol, side, entry_price, exit_price, pnl, realized_pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [trade.cycle_id, trade.symbol, trade.side, trade.entry_price, trade.exit_price, trade.pnl, trade.realized_pnl]
    );
  }
};

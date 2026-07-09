CREATE TABLE IF NOT EXISTS bot_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'STOPPED', -- RUNNING, STOPPED
    phase TEXT NOT NULL DEFAULT 'IDLE',   -- IDLE, COLLECTING, WAITING_ENTRY, BUILDING, HARVESTING
    cycle_id UUID,
    orders JSONB DEFAULT '{}',
    current_pnl DECIMAL DEFAULT 0,
    entry_price DECIMAL DEFAULT 0,
    active_side TEXT,
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT one_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    cycle_id UUID NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price DECIMAL,
    exit_price DECIMAL,
    pnl DECIMAL,
    realized_pnl DECIMAL,
    closed_at TIMESTAMP DEFAULT NOW(),
    -- Strategy comparison fields
    strategy TEXT DEFAULT 'ladder',
    qty DECIMAL,
    fees DECIMAL DEFAULT 0,
    funding DECIMAL DEFAULT 0,
    opened_at TIMESTAMP,
    meta JSONB DEFAULT '{}'
);

-- Signals: every evaluated setup (executed or not), for post-hoc calibration
CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    acted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_strategy_created ON signals (strategy, created_at DESC);

-- Equity curve per strategy (drawdown / Sharpe comparisons)
CREATE TABLE IF NOT EXISTS equity_snapshots (
    id SERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    balance DECIMAL NOT NULL,
    unrealized DECIMAL DEFAULT 0,
    taken_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equity_strategy_taken ON equity_snapshots (strategy, taken_at DESC);

-- Initialize bot state if not exists
INSERT INTO bot_state (id, status, phase)
VALUES (1, 'STOPPED', 'IDLE')
ON CONFLICT (id) DO NOTHING;

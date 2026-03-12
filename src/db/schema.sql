CREATE TABLE IF NOT EXISTS bot_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'STOPPED', -- RUNNING, STOPPED
    phase TEXT NOT NULL DEFAULT 'IDLE',   -- IDLE, WAITING_ENTRY, IN_POSITION
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
    closed_at TIMESTAMP DEFAULT NOW()
);

-- Initialize bot state if not exists
INSERT INTO bot_state (id, status, phase)
VALUES (1, 'STOPPED', 'IDLE')
ON CONFLICT (id) DO NOTHING;

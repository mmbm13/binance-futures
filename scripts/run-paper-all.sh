#!/usr/bin/env bash
# Start momentum, bounce, liqrev and funding in paper mode (one process each).
# Requires: npm install, db migrated, .env + .env.<strategy> overlays.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.paper-bots.pids"
LOG_DIR="$ROOT/logs/paper"
mkdir -p "$LOG_DIR"

BOTS=(
  "momentum:3002"
  "bounce:3003"
  "liqrev:3004"
  "funding:3005"
)

if [[ ! -f .env ]]; then
  echo "Missing .env — copy from .env.example and fill DATABASE_URL + API keys."
  exit 1
fi

for entry in "${BOTS[@]}"; do
  id="${entry%%:*}"
  if [[ ! -f ".env.$id" ]]; then
    echo "Warning: .env.$id not found — copy from .env.$id.example (using defaults + .env only)."
  fi
done

# Stop previous paper fleet if pid file exists
if [[ -f "$PID_FILE" ]]; then
  echo "Stopping previous paper bots from $PID_FILE ..."
  while read -r pid name; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "  stopped $name (pid $pid)"
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  sleep 2
fi

# Global RUNNING so evaluation loops work across processes
if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" || -f .env ]]; then
  DB_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')}"
  if [[ -n "$DB_URL" ]]; then
    psql "$DB_URL" -c "UPDATE bot_state SET status = 'RUNNING', updated_at = NOW() WHERE id = 1;" >/dev/null 2>&1 \
      && echo "bot_state.status set to RUNNING" \
      || echo "Note: could not set bot_state via psql (set RUNNING manually if needed)."
  fi
fi

echo "Starting paper bots..."
: > "$PID_FILE"

for entry in "${BOTS[@]}"; do
  id="${entry%%:*}"
  port="${entry##*:}"
  log="$LOG_DIR/$id.log"
  STRATEGY="$id" EXECUTION_MODE=paper PORT="$port" npm start >>"$log" 2>&1 &
  pid=$!
  echo "$pid $id" >> "$PID_FILE"
  echo "  $id → pid $pid, port $port, log $log"
done

echo "Waiting for HTTP ports..."
for entry in "${BOTS[@]}"; do
  id="${entry%%:*}"
  port="${entry##*:}"
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$port/status" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://127.0.0.1:$port/status" >/dev/null 2>&1; then
    echo "Error: $id did not become ready on port $port — check $LOG_DIR/$id.log"
    exit 1
  fi
done

echo "Sending POST /start to each bot..."
for entry in "${BOTS[@]}"; do
  id="${entry%%:*}"
  port="${entry##*:}"
  curl -sf -X POST "http://127.0.0.1:$port/start" >/dev/null
  echo "  started $id (:$port)"
done

echo ""
echo "Paper fleet running. Compare metrics:"
echo "  curl http://127.0.0.1:3002/compare | jq"
echo ""
echo "Stop all:  npm run paper:stop"
echo "PIDs:      $PID_FILE"

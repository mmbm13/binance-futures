#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.paper-bots.pids"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No pid file at $PID_FILE — nothing to stop."
  exit 0
fi

echo "Stopping paper bots..."
while read -r pid name; do
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "  stopped $name (pid $pid)"
  fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "Done."

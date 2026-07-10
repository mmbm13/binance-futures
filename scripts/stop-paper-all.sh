#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.paper-bots.pids"

# shellcheck source=paper-pids.sh
source "$ROOT/scripts/paper-pids.sh"

echo "Stopping paper bots..."
paper_stop_all "$PID_FILE"
echo "Done."

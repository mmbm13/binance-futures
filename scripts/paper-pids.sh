#!/usr/bin/env bash
# Shared helpers for paper fleet start/stop (source from run/stop scripts).

paper_ports() {
  echo 3002 3003 3004 3005
}

# PID of the process listening on a TCP port (node server), empty if none.
paper_listen_pid() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
    return
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' | head -1
  fi
}

# Stop one paper bot: recorded PID (if any) + whatever still listens on the port.
paper_stop_bot() {
  local pid=${1:-} name=${2:-bot} port=${3:-}
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.3
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "  stopped $name (pid $pid)"
  fi

  if [[ -n "$port" ]]; then
    local listen_pid
    listen_pid="$(paper_listen_pid "$port")"
    if [[ -n "$listen_pid" ]] && kill -0 "$listen_pid" 2>/dev/null; then
      kill "$listen_pid" 2>/dev/null || true
      sleep 0.5
      if kill -0 "$listen_pid" 2>/dev/null; then
        kill -9 "$listen_pid" 2>/dev/null || true
      fi
      echo "  stopped $name on port $port (pid $listen_pid)"
    fi
  fi
}

paper_stop_all() {
  local pid_file=$1
  set +e
  if [[ -f "$pid_file" ]]; then
    while read -r pid name port _; do
      [[ -z "${pid:-}" ]] && continue
      paper_stop_bot "$pid" "$name" "${port:-}"
    done < "$pid_file"
    rm -f "$pid_file"
  fi

  local port
  for port in $(paper_ports); do
    local listen_pid
    listen_pid="$(paper_listen_pid "$port")"
    if [[ -n "$listen_pid" ]]; then
      paper_stop_bot "$listen_pid" "port-$port" "$port"
    fi
  done
  set -e
}

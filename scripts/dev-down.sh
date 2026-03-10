#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_DIR="$RUNTIME_DIR/pids"

kill_from_pidfile() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
    echo "[dev-down] Stopped $name (pid $pid)"
  fi
  rm -f "$pid_file"
}

kill_matching() {
  local pattern="$1"
  local label="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $pids; do
    kill -9 "$pid" 2>/dev/null || true
  done
  echo "[dev-down] Stopped $label"
}

echo "[dev-down] Stopping backend/frontend..."
kill_from_pidfile "server"
kill_from_pidfile "frontend"

kill_matching "tsx watch index\\.ts" "server watchers"
kill_matching "vite --host 0\\.0\\.0\\.0 --port 5173" "frontend dev servers"

echo "[dev-down] Stopping autonomous agents..."
(
  cd "$ROOT_DIR/autonomous-agents"
  bash stop-all.sh >/dev/null 2>&1 || true
)
kill_matching "autonomous-agents/run-(smith|oracle|clank|mouse)\\.sh" "agent wrapper loops"
kill_matching "node --import tsx index\\.ts (smith|oracle|clank|mouse)" "agent node processes"

echo "[dev-down] Done."

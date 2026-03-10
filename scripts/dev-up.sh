#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

source "$ROOT_DIR/autonomous-agents/node-env.sh"
ensure_node_runtime || exit 1
echo "[dev-up] Node runtime: $(node -v)"

stop_from_pidfile() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

start_background() {
  local name="$1"
  local cmd="$2"
  local log_file="$LOG_DIR/$name.log"
  local pid_file="$PID_DIR/$name.pid"

  stop_from_pidfile "$name"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bash -c "$cmd" >"$log_file" 2>&1 &
  else
    nohup bash -c "$cmd" >"$log_file" 2>&1 &
  fi
  local pid=$!
  echo "$pid" >"$pid_file"
  echo "[dev-up] $name started (pid $pid, log: $log_file)"
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local attempts=40
  local i=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$attempts" ]; then
      echo "[dev-up] $name did not become ready at $url"
      return 1
    fi
    sleep 1
  done
  echo "[dev-up] $name ready at $url"
}

echo "[dev-up] Starting backend + frontend + agents..."

start_background "server" "cd '$ROOT_DIR/server' && npm run dev"
start_background "frontend" "cd '$ROOT_DIR' && npm run dev -- --host 0.0.0.0 --port 5173"

(
  cd "$ROOT_DIR/autonomous-agents"
  bash stop-all.sh >/dev/null 2>&1 || true
  bash run-all.sh --stagger=5
)

wait_for_http "Backend" "http://localhost:4101/health"
wait_for_http "Frontend" "http://localhost:5173"

echo "[dev-up] Stack started."
echo "[dev-up] Live logs: npm run dev:logs"
echo "[dev-up] Stop all: npm run dev:down"

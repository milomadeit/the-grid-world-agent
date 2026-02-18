#!/bin/bash
# Stop autonomous agents by killing their process trees.
#
# Usage:
#   ./stop-all.sh              # stop all agents
#   ./stop-all.sh smith oracle # stop only Smith and Oracle

DIR="$(cd "$(dirname "$0")" && pwd)"
PIDS_DIR="$DIR/.pids"

AGENTS=("$@")
if [ ${#AGENTS[@]} -eq 0 ]; then
  AGENTS=(smith oracle clank mouse)
fi

for agent in "${AGENTS[@]}"; do
  KILLED=false

  # 1. Kill the run-wrapper shell (the while-true restart loop)
  WRAPPER_PIDS="$(pgrep -f "run-${agent}\\.sh" 2>/dev/null || true)"
  for PID in $WRAPPER_PIDS; do
    kill "$PID" 2>/dev/null && KILLED=true
  done

  # 2. Kill the actual node process
  NODE_PIDS="$(pgrep -f "index\\.ts ${agent}" 2>/dev/null || true)"
  for PID in $NODE_PIDS; do
    kill "$PID" 2>/dev/null && KILLED=true
  done

  # 3. Try the pid file as fallback
  PID_FILE="$PIDS_DIR/${agent}.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
      KILLED=true
    fi
    rm -f "$PID_FILE"
  fi

  if [ "$KILLED" = true ]; then
    echo "  [OK] $agent stopped"
  else
    echo "  [SKIP] $agent — not running"
  fi
done

# 4. Kill any stray tail watchers on agent logs
TAIL_PIDS="$(pgrep -f "tail.*logs/(smith|oracle|clank|mouse)" 2>/dev/null || true)"
for PID in $TAIL_PIDS; do
  kill "$PID" 2>/dev/null
done

echo "Done."

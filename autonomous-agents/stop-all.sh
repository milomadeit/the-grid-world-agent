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
  PID_FILE="$PIDS_DIR/${agent}.pid"
  if [ ! -f "$PID_FILE" ]; then
    # Fallback: handle agents started manually (no pid file) by killing the run loop script
    # (and if that fails, the node command itself).
    FALLBACK_PIDS="$(pgrep -f "${DIR}/run-${agent}\\.sh" 2>/dev/null || true)"
    if [ -z "$FALLBACK_PIDS" ]; then
      FALLBACK_PIDS="$(pgrep -f "node .*--import tsx .*index\\.ts ${agent}" 2>/dev/null || true)"
    fi
    if [ -z "$FALLBACK_PIDS" ]; then
      echo "  [SKIP] $agent — no pid file"
      continue
    fi

    for PID in $FALLBACK_PIDS; do
      if kill -0 "$PID" 2>/dev/null; then
        kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        echo "  [OK] $agent stopped (matched pid $PID)"
      fi
    done
    continue
  fi

  PID=$(cat "$PID_FILE")

  if kill -0 "$PID" 2>/dev/null; then
    # Kill the process group (the shell + its tsx child)
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
    echo "  [OK] $agent stopped (was pid $PID)"
  else
    echo "  [SKIP] $agent — not running (stale pid $PID)"
  fi

  rm -f "$PID_FILE"
done

echo "Done."

#!/bin/bash
# Stop autonomous agents by killing ALL related processes.
# Handles ghost PIDs, orphaned node processes, and wrapper shells.
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

# Collect all PIDs to kill (deduplicated via temp file)
PID_LIST=$(mktemp)
trap "rm -f $PID_LIST" EXIT

for agent in "${AGENTS[@]}"; do
  # 1. PID file (written by the actual node runtime — most reliable)
  PID_FILE="$PIDS_DIR/${agent}.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "$PID" >> "$PID_LIST"
    fi
    rm -f "$PID_FILE"
  fi

  # 2. pgrep for the run-wrapper shell (while-true restart loop)
  pgrep -f "run-${agent}\\.sh" 2>/dev/null >> "$PID_LIST"

  # 3. pgrep for ANY process with "index.ts <agent>" in its command line
  #    This catches: npx tsx index.ts oracle, node ... index.ts oracle, etc.
  pgrep -f "index\\.ts ${agent}" 2>/dev/null >> "$PID_LIST"

  # 4. npm exec wrappers
  pgrep -f "npm exec tsx index.ts ${agent}" 2>/dev/null >> "$PID_LIST"
done

# Also catch the "index.ts all" launcher and its children
pgrep -f "index\\.ts all" 2>/dev/null >> "$PID_LIST"

# Also catch any stray esbuild service processes from tsx in this project
pgrep -f "esbuild.*autonomous-agents" 2>/dev/null >> "$PID_LIST"

# Deduplicate
PIDS=$(sort -u "$PID_LIST" | grep -v '^$')
COUNT=$(echo "$PIDS" | grep -c '[0-9]' || true)

if [ "$COUNT" -eq 0 ]; then
  echo "No agent processes found."
  exit 0
fi

echo "Found $COUNT agent process(es). Sending SIGTERM..."

# First pass: SIGTERM (graceful)
echo "$PIDS" | xargs kill 2>/dev/null

# Wait briefly for graceful shutdown
sleep 2

# Second pass: SIGKILL anything still alive
REMAINING=0
for PID in $PIDS; do
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null
    REMAINING=$((REMAINING + 1))
  fi
done

if [ "$REMAINING" -gt 0 ]; then
  echo "Force-killed $REMAINING stubborn process(es)."
fi

# Clean up any leftover PID files
for agent in "${AGENTS[@]}"; do
  rm -f "$PIDS_DIR/${agent}.pid" 2>/dev/null
done

# Kill stray tail watchers
pgrep -f "tail.*logs/(smith|oracle|clank|mouse)" 2>/dev/null | xargs kill 2>/dev/null

# Final verification
SURVIVORS=$(ps aux | grep -E 'index\.ts (smith|oracle|clank|mouse|all)' | grep -v grep | wc -l | tr -d ' ')
if [ "$SURVIVORS" -eq 0 ]; then
  echo "All agents stopped. ($COUNT processes killed)"
else
  echo "WARNING: $SURVIVORS process(es) still alive. Run: pkill -9 -f 'index.ts'"
fi

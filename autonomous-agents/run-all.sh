#!/bin/bash
# Start all autonomous agents as fully independent background processes.
# Each agent runs in its own shell with its own restart loop.
# Killing this script does NOT kill the agents.
#
# Usage:
#   ./run-all.sh              # start all immediately
#   ./run-all.sh --30         # wait 30 seconds then start
#   ./run-all.sh --stagger=5  # 5 second offset between each agent
#   ./run-all.sh smith oracle # start only Smith and Oracle
#
# To stop all agents: ./stop-all.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

DELAY=0
STAGGER=5
AGENTS=()

for arg in "$@"; do
  if [[ "$arg" =~ ^--stagger=([0-9]+)$ ]]; then
    STAGGER="${BASH_REMATCH[1]}"
  elif [[ "$arg" == "--no-stagger" ]]; then
    STAGGER=0
  elif [[ "$arg" =~ ^--([0-9]+)$ ]]; then
    DELAY="${BASH_REMATCH[1]}"
  else
    AGENTS+=("$arg")
  fi
done

# Default to all agents if none specified
if [ ${#AGENTS[@]} -eq 0 ]; then
  AGENTS=(smith oracle clank mouse)
fi

if [ "$DELAY" -gt 0 ]; then
  echo "Starting agents in ${DELAY}s..."
  sleep "$DELAY"
fi

PIDS_DIR="$DIR/.pids"
mkdir -p "$PIDS_DIR"

echo "Launching ${#AGENTS[@]} agents as independent processes..."

for agent in "${AGENTS[@]}"; do
  SCRIPT="$DIR/run-${agent}.sh"
  if [ ! -f "$SCRIPT" ]; then
    echo "  [SKIP] No run script for '$agent' ($SCRIPT not found)"
    continue
  fi

  LOG_FILE="$DIR/logs/${agent}.log"
  mkdir -p "$DIR/logs"

  # Launch as a fully independent process (nohup + disown)
  nohup bash "$SCRIPT" > "$LOG_FILE" 2>&1 &
  PID=$!
  echo "$PID" > "$PIDS_DIR/${agent}.pid"
  disown "$PID"

  echo "  [OK] $agent started (pid $PID, log: logs/${agent}.log)"

  # Stagger agent launches to avoid simultaneous API/LLM hits
  if [ "$STAGGER" -gt 0 ] && [ "$agent" != "${AGENTS[-1]}" ]; then
    echo "  ... waiting ${STAGGER}s before next agent"
    sleep "$STAGGER"
  fi
done

echo ""
echo "All agents launched independently."
echo "  View logs:   tail -f logs/smith.log"
echo "  Stop all:    ./stop-all.sh"
echo "  Stop one:    ./stop-all.sh smith"

#!/bin/bash
# Start all autonomous agents with optional delay
# Usage: ./run-all.sh [--SECONDS]
# Examples:
#   ./run-all.sh          # start immediately
#   ./run-all.sh --30     # wait 30 seconds then start
#   ./run-all.sh --180    # wait 3 minutes then start

DELAY=0

for arg in "$@"; do
  if [[ "$arg" =~ ^--([0-9]+)$ ]]; then
    DELAY="${BASH_REMATCH[1]}"
  fi
done

if [ "$DELAY" -gt 0 ]; then
  echo "⏳ Starting agents in ${DELAY}s..."
  sleep "$DELAY"
fi

echo "🚀 Launching all agents"
cd "$(dirname "$0")" && npm run start

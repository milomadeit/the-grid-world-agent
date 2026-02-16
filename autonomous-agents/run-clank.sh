#!/bin/bash
# Run Clank independently with auto-restart on crash
# Usage: ./run-clank.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

source "$DIR/node-env.sh"
ensure_node_runtime || exit 1

echo "[Clank] Starting agent (independent process, pid $$)"
echo "[Clank] Runtime: $(node -v)"

while true; do
  node --import tsx index.ts clank
  EXIT_CODE=$?
  echo "[Clank] Exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done

#!/bin/bash
# Run Mouse independently with auto-restart on crash
# Usage: ./run-mouse.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

source "$DIR/node-env.sh"
ensure_node_runtime || exit 1

echo "[Mouse] Starting agent (independent process, pid $$)"
echo "[Mouse] Runtime: $(node -v)"

while true; do
  node --import tsx index.ts mouse
  EXIT_CODE=$?
  echo "[Mouse] Exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done

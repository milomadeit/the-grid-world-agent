#!/bin/bash
# Run Oracle independently with auto-restart on crash
# Usage: ./run-oracle.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

source "$DIR/node-env.sh"
ensure_node_runtime || exit 1

echo "[Oracle] Starting agent (independent process, pid $$)"
echo "[Oracle] Runtime: $(node -v)"

while true; do
  node --import tsx index.ts oracle
  EXIT_CODE=$?
  echo "[Oracle] Exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done

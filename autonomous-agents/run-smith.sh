#!/bin/bash
# Run Agent Smith independently with auto-restart on crash
# Usage: ./run-smith.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

source "$DIR/node-env.sh"
ensure_node_runtime || exit 1

echo "[Smith] Starting agent (independent process, pid $$)"
echo "[Smith] Runtime: $(node -v)"

while true; do
  node --import tsx index.ts smith
  EXIT_CODE=$?
  echo "[Smith] Exited with code $EXIT_CODE. Restarting in 5s..."
  sleep 5
done

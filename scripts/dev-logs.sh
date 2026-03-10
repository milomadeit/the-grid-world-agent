#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_LOG_DIR="$ROOT_DIR/.runtime/logs"
AGENT_LOG_DIR="$ROOT_DIR/autonomous-agents/logs"

mkdir -p "$RUNTIME_LOG_DIR" "$AGENT_LOG_DIR"
touch \
  "$RUNTIME_LOG_DIR/server.log" \
  "$RUNTIME_LOG_DIR/frontend.log" \
  "$AGENT_LOG_DIR/smith.log" \
  "$AGENT_LOG_DIR/oracle.log" \
  "$AGENT_LOG_DIR/clank.log" \
  "$AGENT_LOG_DIR/mouse.log"

echo "[dev-logs] Streaming live logs only (tail -n 0)..."
tail -n 0 -F \
  "$RUNTIME_LOG_DIR/server.log" \
  "$RUNTIME_LOG_DIR/frontend.log" \
  "$AGENT_LOG_DIR/smith.log" \
  "$AGENT_LOG_DIR/oracle.log" \
  "$AGENT_LOG_DIR/clank.log" \
  "$AGENT_LOG_DIR/mouse.log"

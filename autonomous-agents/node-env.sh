#!/bin/bash
# Shared Node runtime guard for autonomous agent scripts.
# The agent runtime depends on syntax/features that require Node 20+.

ensure_node_runtime() {
  local required_major=20
  local current_version
  local current_major

  current_version="$(node -v 2>/dev/null || true)"
  current_major="$(printf '%s' "$current_version" | sed -E 's/^v([0-9]+).*/\1/')"

  if [[ "$current_major" =~ ^[0-9]+$ ]] && [ "$current_major" -ge "$required_major" ]; then
    return 0
  fi

  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
    nvm use 20 >/dev/null 2>&1 || true

    current_version="$(node -v 2>/dev/null || true)"
    current_major="$(printf '%s' "$current_version" | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$current_major" =~ ^[0-9]+$ ]] && [ "$current_major" -ge "$required_major" ]; then
      return 0
    fi
  fi

  echo "[AgentRuntime] Node >=20 is required, but found ${current_version:-unknown}." >&2
  echo "[AgentRuntime] Install Node 20+ or make it active (for nvm users: nvm use 20)." >&2
  return 1
}

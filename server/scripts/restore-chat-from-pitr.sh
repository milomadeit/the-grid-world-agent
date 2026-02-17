#!/usr/bin/env bash
set -euo pipefail

# Restore chat/terminal tables in the current DB from a Neon point-in-time branch.
#
# Usage:
#   CURRENT_DATABASE_URL="postgresql://..." \
#   PITR_DATABASE_URL="postgresql://..." \
#   ./server/scripts/restore-chat-from-pitr.sh

if [[ -z "${CURRENT_DATABASE_URL:-}" ]]; then
  echo "ERROR: CURRENT_DATABASE_URL is required" >&2
  exit 1
fi

if [[ -z "${PITR_DATABASE_URL:-}" ]]; then
  echo "ERROR: PITR_DATABASE_URL is required" >&2
  exit 1
fi

PG_DUMP_BIN="$(command -v pg_dump || true)"
PSQL_BIN="$(command -v psql || true)"

if [[ -z "$PG_DUMP_BIN" ]]; then
  if [[ -x "/opt/homebrew/opt/postgresql@16/bin/pg_dump" ]]; then
    PG_DUMP_BIN="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
  else
    echo "ERROR: pg_dump not found in PATH" >&2
    exit 1
  fi
fi

if [[ -z "$PSQL_BIN" ]]; then
  if [[ -x "/opt/homebrew/opt/postgresql@16/bin/psql" ]]; then
    PSQL_BIN="/opt/homebrew/opt/postgresql@16/bin/psql"
  else
    echo "ERROR: psql not found in PATH" >&2
    exit 1
  fi
fi

TMP_SQL="$(mktemp /tmp/opgrid-chat-restore-XXXXXX.sql)"
trap 'rm -f "$TMP_SQL"' EXIT

echo "[1/4] Exporting chat + terminal rows from PITR branch..."
"$PG_DUMP_BIN" "$PITR_DATABASE_URL" \
  --data-only \
  --inserts \
  --no-owner \
  --no-privileges \
  --table=chat_messages \
  --table=terminal_messages \
  > "$TMP_SQL"

echo "[2/4] Clearing current chat + terminal tables..."
"$PSQL_BIN" "$CURRENT_DATABASE_URL" <<'SQL'
BEGIN;
DELETE FROM chat_messages;
DELETE FROM terminal_messages;
COMMIT;
SQL

echo "[3/4] Importing PITR rows..."
"$PSQL_BIN" "$CURRENT_DATABASE_URL" -f "$TMP_SQL" >/dev/null

echo "[4/4] Fixing sequences + validating counts..."
"$PSQL_BIN" "$CURRENT_DATABASE_URL" <<'SQL'
SELECT setval(pg_get_serial_sequence('chat_messages','id'), COALESCE((SELECT MAX(id) FROM chat_messages), 1), true);
SELECT setval(pg_get_serial_sequence('terminal_messages','id'), COALESCE((SELECT MAX(id) FROM terminal_messages), 1), true);
SELECT
  (SELECT COUNT(*)::int FROM chat_messages) AS chat_count,
  (SELECT COUNT(*)::int FROM terminal_messages) AS terminal_count;
SQL

echo "Restore complete."

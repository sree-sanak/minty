#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# --- Step-log diagnostics ---
STEP_LOG="$(mktemp "${TMPDIR:-/tmp}/minty-refresh-steps.XXXXXX.jsonl")"

log_step() {
  local id="$1" status="$2" exit_code="${3:-0}" started_at="$4" error="${5:-}"
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local duration_ms=0
  if [ -n "$started_at" ]; then
    local s_epoch f_epoch
    s_epoch="$(date -u -d "$started_at" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%S" "${started_at%%.*}" +%s 2>/dev/null || echo 0)"
    f_epoch="$(date -u +%s)"
    duration_ms=$(( (f_epoch - s_epoch) * 1000 ))
  fi
  local entry="{\"id\":\"$id\",\"status\":\"$status\",\"exitCode\":$exit_code,\"startedAt\":\"$started_at\",\"finishedAt\":\"$finished_at\",\"durationMs\":$duration_ms"
  if [ -n "$error" ]; then
    # Escape double quotes in error for JSON
    local escaped_error="${error//\"/\\\"}"
    entry="$entry,\"error\":\"$escaped_error\""
  fi
  entry="$entry}"
  echo "$entry" >> "$STEP_LOG"
}

write_diagnostics() {
  local refresh_rc=$?
  local diagnostics_rc=0
  if node "$ROOT_DIR/scripts/memory-refresh-diagnostics.js" "$STEP_LOG" "$ROOT_DIR"; then
    rm -f "$STEP_LOG"
    return "$refresh_rc"
  fi
  diagnostics_rc=$?
  rm -f "$STEP_LOG"
  echo "Failed to write memory refresh diagnostics (exit code $diagnostics_rc)." >&2
  if [ "$refresh_rc" -ne 0 ]; then
    return "$refresh_rc"
  fi
  return "$diagnostics_rc"
}

trap write_diagnostics EXIT

run_step() {
  local id="$1"
  shift
  local started_at
  started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then
    log_step "$id" "ok" 0 "$started_at"
  else
    log_step "$id" "failed" "$rc" "$started_at" "exit code $rc"
  fi
  return "$rc"
}

skip_step() {
  local id="$1" reason="${2:-unavailable}"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  log_step "$id" "skipped" 0 "$now" "$reason"
}

# --- Begin refresh ---

echo "Refreshing Minty source data from Hermes Google profiles…"

# Sree's Hermes setup can have separate work and personal OAuth profiles. The
# People API may legitimately return contacts from only one of them, so include
# every known local token profile by default without printing token paths.
TOKEN_PROFILES=()
if [ -f /root/.hermes/google_token.json ]; then
  TOKEN_PROFILES+=("work=/root/.hermes/google_token.json")
fi
if [ -f /root/.hermes/google-personal/google_token.json ]; then
  TOKEN_PROFILES+=("personal=/root/.hermes/google-personal/google_token.json")
fi

if [ "${#TOKEN_PROFILES[@]}" -gt 0 ]; then
  run_step google_contacts env MINTY_GOOGLE_TOKEN_FILES="$(IFS=,; echo "${TOKEN_PROFILES[*]}")" npm run google-contacts:hermes || true
else
  run_step google_contacts npm run google-contacts:hermes || true
fi

echo "Refreshing Minty Telegram source data…"
# Prefer native/live Telegram when local credentials are configured. Fall back to
# the static Telegram Desktop export only when live credentials are unavailable
# or the live sync fails. Do not print credential values.
if [ -f "$ROOT_DIR/.env" ] && grep -q '^TELEGRAM_API_ID=' "$ROOT_DIR/.env" && grep -q '^TELEGRAM_API_HASH=' "$ROOT_DIR/.env" && grep -q '^TELEGRAM_SESSION=' "$ROOT_DIR/.env"; then
  telegram_started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if npm run telegram:live; then
    log_step telegram_live "ok" 0 "$telegram_started_at"
    echo "Telegram live sync complete."
  else
    telegram_rc=$?
    echo "Telegram live sync failed; falling back to existing Telegram export if available."
    log_step telegram_live "failed" "$telegram_rc" "$telegram_started_at" "live sync failed; attempted Desktop export fallback"
    if [ -f "$ROOT_DIR/data/telegram/export/result.json" ]; then
      run_step telegram npm run telegram
    else
      log_step telegram "failed" "$telegram_rc" "$telegram_started_at" "live sync failed and no Desktop export was available"
    fi
  fi
elif [ -f "$ROOT_DIR/data/telegram/export/result.json" ]; then
  echo "Telegram live credentials not configured; using Telegram Desktop export."
  run_step telegram npm run telegram
else
  echo "Skipping Telegram sync: no live credentials or Desktop export found."
  skip_step telegram "no live credentials or Desktop export found"
fi

echo "Rebuilding Minty unified network data…"
run_step merge npm run merge

if node -e "process.exit(require('./package.json').scripts['contact-evidence'] ? 0 : 1)"; then
  echo "Building privacy-safe contact evidence…"
  run_step contact_evidence npm run contact-evidence
else
  skip_step contact_evidence "script not available"
fi
if node -e "process.exit(require('./package.json').scripts['source-events'] ? 0 : 1)"; then
  echo "Building privacy-safe source events…"
  run_step source_events npm run source-events
else
  skip_step source_events "script not available"
fi
if node -e "process.exit(require('./package.json').scripts['hybrid-index'] ? 0 : 1)"; then
  echo "Building hybrid retrieval index…"
  run_step hybrid_index npm run hybrid-index
else
  skip_step hybrid_index "script not available"
fi
if node -e "process.exit(require('./package.json').scripts.index ? 0 : 1)"; then
  echo "Building query index…"
  run_step query_index npm run index
else
  skip_step query_index "script not available"
fi

echo "Exporting privacy-safe relationship memory for GBrain…"
run_step gbrain_export npm run gbrain:export -- --data-dir "$ROOT_DIR/data" --out-dir "$ROOT_DIR/data/gbrain"

if command -v gbrain-hermes >/dev/null 2>&1 && [ -d /root/.hermes/private/brain ]; then
  mkdir -p /root/.hermes/private/brain/projects
  cp "$ROOT_DIR/data/gbrain/relationship-memory.md" /root/.hermes/private/brain/projects/minty-relationship-memory.md
  echo "Importing Minty relationship memory into private GBrain…"
  run_step gbrain_import gbrain-hermes import /root/.hermes/private/brain --no-embed
else
  echo "Skipping GBrain import: gbrain-hermes or private brain directory not available."
  skip_step gbrain_import "gbrain-hermes or private brain directory not available"
fi

if command -v hermes >/dev/null 2>&1; then
  echo "Verifying Minty MCP registration…"
  run_step mcp_smoke hermes mcp test minty
else
  echo "Skipping MCP smoke test: hermes CLI not available."
  skip_step mcp_smoke "hermes CLI not available"
fi

echo "Minty Hermes memory refresh complete."

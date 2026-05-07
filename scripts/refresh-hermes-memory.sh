#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
  MINTY_GOOGLE_TOKEN_FILES="$(IFS=,; echo "${TOKEN_PROFILES[*]}")" npm run google-contacts:hermes
else
  npm run google-contacts:hermes
fi

echo "Refreshing Minty Telegram source data…"
# Prefer native/live Telegram when local credentials are configured. Fall back to
# the static Telegram Desktop export only when live credentials are unavailable
# or the live sync fails. Do not print credential values.
if [ -f "$ROOT_DIR/.env" ] && grep -q '^TELEGRAM_API_ID=' "$ROOT_DIR/.env" && grep -q '^TELEGRAM_API_HASH=' "$ROOT_DIR/.env" && grep -q '^TELEGRAM_SESSION=' "$ROOT_DIR/.env"; then
  if npm run telegram:live; then
    echo "Telegram live sync complete."
  else
    echo "Telegram live sync failed; falling back to existing Telegram export if available."
    if [ -f "$ROOT_DIR/data/telegram/export/result.json" ]; then
      npm run telegram
    fi
  fi
elif [ -f "$ROOT_DIR/data/telegram/export/result.json" ]; then
  echo "Telegram live credentials not configured; using Telegram Desktop export."
  npm run telegram
else
  echo "Skipping Telegram sync: no live credentials or Desktop export found."
fi

echo "Rebuilding Minty unified network data…"
npm run merge

if node -e "process.exit(require('./package.json').scripts['contact-evidence'] ? 0 : 1)"; then
  echo "Building privacy-safe contact evidence…"
  npm run contact-evidence
fi
if node -e "process.exit(require('./package.json').scripts['source-events'] ? 0 : 1)"; then
  echo "Building privacy-safe source events…"
  npm run source-events
fi
if node -e "process.exit(require('./package.json').scripts['hybrid-index'] ? 0 : 1)"; then
  echo "Building hybrid retrieval index…"
  npm run hybrid-index
fi
if node -e "process.exit(require('./package.json').scripts.index ? 0 : 1)"; then
  echo "Building query index…"
  npm run index
fi

echo "Exporting privacy-safe relationship memory for GBrain…"
npm run gbrain:export -- --data-dir "$ROOT_DIR/data" --out-dir "$ROOT_DIR/data/gbrain"

if command -v gbrain-hermes >/dev/null 2>&1 && [ -d /root/.hermes/private/brain ]; then
  mkdir -p /root/.hermes/private/brain/projects
  cp "$ROOT_DIR/data/gbrain/relationship-memory.md" /root/.hermes/private/brain/projects/minty-relationship-memory.md
  echo "Importing Minty relationship memory into private GBrain…"
  gbrain-hermes import /root/.hermes/private/brain --no-embed
else
  echo "Skipping GBrain import: gbrain-hermes or private brain directory not available."
fi

if command -v hermes >/dev/null 2>&1; then
  echo "Verifying Minty MCP registration…"
  hermes mcp test minty
else
  echo "Skipping MCP smoke test: hermes CLI not available."
fi

echo "Minty Hermes memory refresh complete."

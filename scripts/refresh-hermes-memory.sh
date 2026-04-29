#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Refreshing Minty source data from Hermes Google profiles…"
npm run google-contacts:hermes

echo "Rebuilding Minty unified network data…"
npm run merge

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

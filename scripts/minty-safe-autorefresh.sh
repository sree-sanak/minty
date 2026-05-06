#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${MINTY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOCK="/tmp/minty-safe-autorefresh.lock"
LOG_DIR="/root/.hermes/cron/output/minty"
LOG_FILE="$LOG_DIR/safe-autorefresh.log"
export LOG_FILE
mkdir -p "$LOG_DIR"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo '{"ok":true,"skipped":"already_running"}'
  exit 0
fi

cd "$ROOT_DIR"

export MINTY_SAFE_MODE="${MINTY_SAFE_MODE:-1}"
export MINTY_INCREMENTAL="${MINTY_INCREMENTAL:-1}"
export GOOGLE_CONTACTS_SAFE_MODE="${GOOGLE_CONTACTS_SAFE_MODE:-1}"
export GOOGLE_CONTACTS_INCREMENTAL="${GOOGLE_CONTACTS_INCREMENTAL:-1}"
export EMAIL_SAFE_MODE="${EMAIL_SAFE_MODE:-1}"
export EMAIL_INCREMENTAL="${EMAIL_INCREMENTAL:-1}"
export GMAIL_INCREMENTAL="${GMAIL_INCREMENTAL:-1}"
export SLACK_SAFE_MODE="${SLACK_SAFE_MODE:-1}"
export TELEGRAM_SAFE_MODE="${TELEGRAM_SAFE_MODE:-1}"
export APOLLO_SAFE_MODE="${APOLLO_SAFE_MODE:-1}"
export LINKEDIN_SAFE_MODE="${LINKEDIN_SAFE_MODE:-1}"

# Slack: safe, threaded, bounded. This is intentionally context-rich but not bulk-extractive.
export SLACK_INCREMENTAL="${SLACK_INCREMENTAL:-1}"
export SLACK_INCLUDE_THREADS="${SLACK_INCLUDE_THREADS:-1}"
export SLACK_MESSAGE_CHANNEL_LIMIT="${SLACK_MESSAGE_CHANNEL_LIMIT:-30}"
export SLACK_MESSAGE_LIMIT_PER_CHANNEL="${SLACK_MESSAGE_LIMIT_PER_CHANNEL:-200}"
export SLACK_MESSAGE_PAGE_LIMIT="${SLACK_MESSAGE_PAGE_LIMIT:-50}"
export SLACK_THREAD_LIMIT_PER_CHANNEL="${SLACK_THREAD_LIMIT_PER_CHANNEL:-20}"
export SLACK_API_DELAY_MS="${SLACK_API_DELAY_MS:-1000}"
export SLACK_CHANNEL_DELAY_MS="${SLACK_CHANNEL_DELAY_MS:-1000}"
export SLACK_MAX_API_CALLS="${SLACK_MAX_API_CALLS:-250}"

# Bound autonomous refreshes. A stale source should degrade the refresh, not hang
# the whole primitive or require an LLM cron wrapper to notice it.
export MINTY_STEP_TIMEOUT_DEFAULT="${MINTY_STEP_TIMEOUT_DEFAULT:-10m}"
export MINTY_STEP_TIMEOUT_SLACK="${MINTY_STEP_TIMEOUT_SLACK:-12m}"
export MINTY_STEP_TIMEOUT_GMAIL="${MINTY_STEP_TIMEOUT_GMAIL:-8m}"
export MINTY_STEP_TIMEOUT_BUILD="${MINTY_STEP_TIMEOUT_BUILD:-5m}"

# Other live/API sources: modest caps by default and incremental windows. Local file importers
# (SMS XML, Telegram Desktop JSON, LinkedIn ZIP) are reread locally but do not hit external APIs.
export EMAIL_LIMIT="${EMAIL_LIMIT:-250}"
export EMAIL_PAGE_LIMIT="${EMAIL_PAGE_LIMIT:-50}"
export GMAIL_LIMIT="${GMAIL_LIMIT:-250}"
export GMAIL_LOOKBACK_DAYS="${GMAIL_LOOKBACK_DAYS:-30}"
export CALENDAR_LIMIT="${CALENDAR_LIMIT:-250}"
export GOOGLE_CONTACTS_LIMIT="${GOOGLE_CONTACTS_LIMIT:-500}"
export GOOGLE_CONTACTS_PAGE_SIZE="${GOOGLE_CONTACTS_PAGE_SIZE:-100}"
export TELEGRAM_DIALOG_LIMIT="${TELEGRAM_DIALOG_LIMIT:-200}"
export TELEGRAM_MESSAGE_LIMIT="${TELEGRAM_MESSAGE_LIMIT:-500}"

: > "$LOG_FILE"

run_step() {
  local name="$1"; shift
  local timeout_for_step="$MINTY_STEP_TIMEOUT_DEFAULT"
  case "$name" in
    gmail_calendar|email) timeout_for_step="$MINTY_STEP_TIMEOUT_GMAIL" ;;
    slack_directory|slack_messages) timeout_for_step="$MINTY_STEP_TIMEOUT_SLACK" ;;
    merge|contact_evidence|source_events|hybrid_index|query_index|gbrain_export|gbrain_import) timeout_for_step="$MINTY_STEP_TIMEOUT_BUILD" ;;
  esac
  local start end code
  start=$(date -u +%s)
  echo "[$(date -u +%FT%TZ)] start $name timeout=$timeout_for_step cmd=$*" >> "$LOG_FILE"
  if timeout --preserve-status --kill-after=30s "$timeout_for_step" "$@" >> "$LOG_FILE" 2>&1; then
    code=0
  else
    code=$?
    if [ "$code" -eq 143 ] || [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
      echo "[$(date -u +%FT%TZ)] timeout $name after $timeout_for_step" >> "$LOG_FILE"
    fi
  fi
  end=$(date -u +%s)
  printf '{"step":"%s","exit":%s,"seconds":%s,"timeout":"%s"}\n' "$name" "$code" "$((end-start))" "$timeout_for_step" >> "$LOG_FILE"
  return 0
}

# Source refreshes. Avoid WhatsApp Web and LinkedIn browser scraping in autonomous mode.
run_step google_contacts npm run google-contacts:hermes
if [ -x /root/.hermes/scripts/minty-sync-gmail-calendar.py ]; then
  run_step gmail_calendar /root/.hermes/scripts/minty-sync-gmail-calendar.py
else
  run_step email npm run email
fi
run_step telegram_export npm run telegram
run_step sms_export npm run sms
if [ -f sources/slack/import.js ]; then
  run_step slack_directory node sources/slack/import.js
fi
if [ -f sources/slack/import-messages.js ]; then
  run_step slack_messages node sources/slack/import-messages.js
fi

# Rebuild all local privacy-safe artifacts.
run_step merge npm run merge
run_step contact_evidence npm run contact-evidence
if [ -f scripts/build-source-events.js ]; then run_step source_events npm run source-events; fi
if [ -f scripts/build-hybrid-index.js ]; then run_step hybrid_index npm run hybrid-index; fi
run_step query_index npm run index
if [ -f scripts/export-gbrain-memory.js ]; then
  run_step gbrain_export npm run gbrain:export -- --data-dir "$ROOT_DIR/data" --out-dir "$ROOT_DIR/data/gbrain"
fi
if command -v gbrain-hermes >/dev/null 2>&1 && [ -d /root/.hermes/private/brain ]; then
  run_step gbrain_import gbrain-hermes import /root/.hermes/private/brain --no-embed
fi

node - <<'NODE'
const fs = require('fs');
function read(p, f) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } }
const meta = read('data/slack/messages/meta.json', {});
const contacts = read('data/unified/contacts.json', []);
const interactions = read('data/unified/interactions.json', []);
const evidence = read('data/unified/contact-evidence.json', {});
const index = read('data/unified/query-index.json', []);
const stepLines = (() => {
  try { return fs.readFileSync(process.env.LOG_FILE, 'utf8').split('\n').filter(l => l.startsWith('{"step"')).map(l => JSON.parse(l)); }
  catch { return []; }
})();
const failedSteps = stepLines.filter(s => s.exit !== 0).map(s => ({ step: s.step, exit: s.exit, seconds: s.seconds, timeout: s.timeout }));
const rows = Object.values(evidence || {});
const sourceCounts = {};
for (const r of rows) for (const s of (r.sources || [])) sourceCounts[s] = (sourceCounts[s] || 0) + 1;
console.log(JSON.stringify({
  ok: failedSteps.length === 0,
  refreshedAt: new Date().toISOString(),
  safeMode: true,
  steps: {
    total: stepLines.length,
    failed: failedSteps,
    degraded: failedSteps.length > 0,
  },
  slack: {
    totalMessages: meta.totalMessages || 0,
    channels: meta.successfulChannelCount || 0,
    includeThreads: !!meta.includeThreads,
    apiCallCount: meta.apiCallCount || 0,
    safeMode: !!meta.safeMode,
  },
  unified: {
    contacts: contacts.length,
    interactions: interactions.length,
    evidenceContacts: rows.length,
    sourceEvidenceContacts: sourceCounts,
    queryIndex: Array.isArray(index) ? index.length : 0,
  },
  privacy: {
    aggregateOnly: true,
    rawMessageOutput: false,
    tokenOutput: false,
  },
}, null, 2));
NODE

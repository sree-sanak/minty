'use strict';

const SAFE_STEP_IDS = new Set([
    'google_contacts',
    'telegram_live',
    'telegram',
    'merge',
    'contact_evidence',
    'source_events',
    'hybrid_index',
    'query_index',
    'gbrain_export',
    'gbrain_import',
    'mcp_smoke',
]);

const STEP_NEXT_ACTIONS = {
    google_contacts: 'Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.',
    telegram_live: 'Fix Telegram live refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.',
    telegram: 'Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.',
    merge: 'Fix source import output and rerun npm run merge, then npm run memory:refresh.',
    contact_evidence: 'Run npm run contact-evidence after merge succeeds, then rerun npm run memory:refresh.',
    source_events: 'Run npm run source-events after contact evidence succeeds, then rerun npm run memory:refresh.',
    hybrid_index: 'Run npm run hybrid-index after source events exist, then rerun npm run memory:refresh.',
    query_index: 'Run npm run index after merge succeeds, then rerun npm run memory:refresh.',
    gbrain_export: 'Run npm run gbrain:export after unified data exists, then rerun npm run memory:refresh.',
    gbrain_import: 'Install or repair gbrain-hermes/private brain import, then rerun npm run memory:refresh.',
    mcp_smoke: 'Install or expose Hermes CLI, then rerun npm run memory:refresh to verify MCP registration.',
};

const SAFE_ARTIFACT_IDS = new Set([
    'contacts',
    'interactions',
    'insights',
    'digest',
    'contactEvidence',
    'sourceEvents',
    'hybridIndex',
    'queryIndex',
    'gbrainJsonl',
    'syncState',
]);

const SENSITIVE_DIAGNOSTIC_KEY = '[A-Z0-9_]*(?:API[_-]?(?:KEY|ID|HASH)|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION|CREDENTIAL|AUTH|COOKIE)[A-Z0-9_]*';
const SENSITIVE_DIAGNOSTIC_KEY_VALUE_RE = new RegExp(`["']?\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b["']?\\s*[:=]\\s*(?:Bearer\\s+[^\\s,;}]+|["'][^"']+["']|[^\\s,"'}]+)`, 'gi');
const SENSITIVE_DIAGNOSTIC_KEY_SPACE_VALUE_RE = new RegExp(`\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b\\s+(?:Bearer\\s+[^\\s,;}]+|["'][^"']+["']|[^\\s,"'}]+)`, 'gi');
const SENSITIVE_DIAGNOSTIC_KEY_RE = new RegExp(`\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b`, 'gi');

function redactDiagnosticValue(value) {
    if (value == null) return value;
    const raw = String(value);
    let text = raw
        .replace(SENSITIVE_DIAGNOSTIC_KEY_VALUE_RE, '[redacted-value]')
        .replace(SENSITIVE_DIAGNOSTIC_KEY_SPACE_VALUE_RE, '[redacted-value]')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
        .replace(/\+?\d[\d*\s().-]{6,}\d/g, '[redacted-phone]')
        .replace(/(?:\/root|\/home\/[^\/\s"']+|\/Users\/[^\/\s"']+)[^\s"']*/g, '[redacted-private-path]')
        .replace(/[A-Za-z]:\\Users\\[^\s"']*/g, '[redacted-private-path]')
        .replace(/\/[^\s"']*google_token[^\s"']*/gi, '[redacted-token-path]')
        .replace(SENSITIVE_DIAGNOSTIC_KEY_RE, '[redacted-name]')
        .replace(/raw message[^.\n]*/gi, '[redacted-message]')
        .replace(/group chat[^.\n]*/gi, '[redacted-group]');
    if (text.length > 180) text = text.slice(0, 177) + '...';
    return text;
}

function safeIso(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
    if (!match) return null;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    const iso = new Date(t).toISOString();
    const expected = `${match[1]}T${match[2]}.${(match[3] || '').padEnd(3, '0')}Z`;
    return iso === expected ? iso : null;
}

function sanitizeStep(step) {
    const id = SAFE_STEP_IDS.has(step && step.id) ? step.id : 'unknown';
    const status = ['ok', 'failed', 'skipped', 'warning'].includes(step && step.status) ? step.status : 'warning';
    const out = {
        id,
        label: id,
        status,
        startedAt: safeIso(step && step.startedAt),
        finishedAt: safeIso(step && step.finishedAt),
    };
    const duration = Number(step && step.durationMs);
    if (Number.isFinite(duration) && duration >= 0) out.durationMs = Math.floor(duration);
    const exitCode = Number(step && step.exitCode);
    if (Number.isInteger(exitCode)) out.exitCode = exitCode;
    if (step && step.error) out.error = redactDiagnosticValue(step.error);
    if (step && step.warning) out.warning = redactDiagnosticValue(step.warning);
    return out;
}

function sanitizeArtifact(row) {
    const exists = Boolean(row && row.exists);
    const out = { exists };
    if (Number.isFinite(row && row.count)) out.count = Math.max(0, Math.floor(row.count));
    const mtime = safeIso(row && row.mtime);
    if (mtime) out.mtime = mtime;
    return out;
}

function buildRefreshStatus(input = {}) {
    const steps = Array.isArray(input.steps) ? input.steps.map(sanitizeStep) : [];
    const artifacts = Object.create(null);
    for (const [name, row] of Object.entries(input.artifacts || {})) {
        if (!SAFE_ARTIFACT_IDS.has(name)) continue;
        artifacts[name] = sanitizeArtifact(row);
    }

    const failed = steps.find(s => s.status === 'failed');
    const warnings = [];
    for (const [name, row] of Object.entries(artifacts)) {
        if (!row.exists) warnings.push(`${name}_missing`);
    }
    for (const step of steps) {
        if (step.status === 'warning' || step.status === 'skipped') warnings.push(`${step.id}_${step.status}`);
    }

    const status = failed ? 'failed' : warnings.length ? 'warning' : 'ok';
    const nextActions = [];
    if (failed && STEP_NEXT_ACTIONS[failed.id]) nextActions.push(STEP_NEXT_ACTIONS[failed.id]);
    if (!failed) {
        for (const step of steps) {
            if ((step.status === 'warning' || step.status === 'skipped') && STEP_NEXT_ACTIONS[step.id]) {
                nextActions.push(STEP_NEXT_ACTIONS[step.id]);
                break;
            }
        }
    }
    if (!nextActions.length && warnings.some(w => w.endsWith('_missing'))) {
        nextActions.push('Rerun npm run memory:refresh so missing privacy-safe artifacts are rebuilt.');
    }

    return {
        schemaVersion: 1,
        generatedAt: safeIso(input.generatedAt) || new Date().toISOString(),
        status,
        failedStep: failed ? failed.id : null,
        steps,
        artifacts,
        warnings: [...new Set(warnings)].sort(),
        nextActions,
        safety: {
            redacted: true,
            directContactDetailsOmitted: true,
            privatePathsOmitted: true,
            rawMessagesOmitted: true,
            readOnlyDiagnostics: true,
        },
    };
}

module.exports = {
    SAFE_STEP_IDS,
    SAFE_ARTIFACT_IDS,
    STEP_NEXT_ACTIONS,
    buildRefreshStatus,
    redactDiagnosticValue,
    sanitizeArtifact,
    sanitizeStep,
};

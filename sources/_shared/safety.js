'use strict';

function normalizePrefix(source) {
  return String(source || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function envBool(name, env = process.env, fallback = false) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function envInt(name, env = process.env, fallback = 0, min = 0) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function buildSafetyConfig(source, env = process.env, options = {}) {
  const prefix = normalizePrefix(source);
  const globalSafe = envBool('MINTY_SAFE_MODE', env, true);
  const safeMode = envBool(`${prefix}_SAFE_MODE`, env, globalSafe);
  const globalIncremental = envBool('MINTY_INCREMENTAL', env, true);
  const incremental = envBool(`${prefix}_INCREMENTAL`, env, globalIncremental);

  const defaultMaxApiCalls = options.defaultMaxApiCalls ?? (safeMode ? 300 : 3000);
  const unsafeMaxApiCalls = options.unsafeMaxApiCalls ?? defaultMaxApiCalls;
  const defaultDelayMs = options.defaultDelayMs ?? (safeMode ? 1000 : 0);
  const unsafeDelayMs = options.unsafeDelayMs ?? defaultDelayMs;

  return {
    source: String(source || '').toLowerCase(),
    envPrefix: prefix,
    safeMode,
    incremental,
    maxApiCalls: envInt(`${prefix}_MAX_API_CALLS`, env, safeMode ? defaultMaxApiCalls : unsafeMaxApiCalls, 1),
    delayMs: envInt(`${prefix}_API_DELAY_MS`, env, safeMode ? defaultDelayMs : unsafeDelayMs, 0),
  };
}

module.exports = {
  buildSafetyConfig,
  envBool,
  envInt,
  normalizePrefix,
};

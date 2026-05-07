'use strict';

function envFlag(name, fallback = true, env = process.env) {
  const value = env[name];
  if (value == null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const n = Number.parseInt(env[name] || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sourceSafeMode(source, env = process.env) {
  const key = `${String(source).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SAFE_MODE`;
  if (env[key] != null) return envFlag(key, true, env);
  return envFlag('MINTY_SAFE_MODE', true, env);
}

function safeInt(source, name, safeDefault, normalDefault, opts = {}, env = process.env) {
  const key = `${String(source).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${name}`;
  const safeMode = sourceSafeMode(source, env);
  return intEnv(key, safeMode ? safeDefault : normalDefault, opts, env);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createPacer({ source = 'source', delayMs = 0, maxCalls = 0, now = () => Date.now(), wait = sleep } = {}) {
  let calls = 0;
  let lastAt = 0;
  return {
    async pace() {
      if (maxCalls > 0 && calls >= maxCalls) {
        throw new Error(`${source} safety stop: reached max API/browser calls (${maxCalls}). Resume later or raise the limit explicitly.`);
      }
      const elapsed = now() - lastAt;
      if (lastAt && delayMs > 0 && elapsed < delayMs) await wait(delayMs - elapsed);
      lastAt = now();
      calls += 1;
    },
    get calls() { return calls; },
  };
}

module.exports = {
  createPacer,
  envFlag,
  intEnv,
  safeInt,
  sleep,
  sourceSafeMode,
};

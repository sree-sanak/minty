#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildSafetyConfig, envBool, envInt } = require('../_shared/safety');

const ROOT = path.resolve(__dirname, '../..');
const DATA = process.env.CRM_DATA_DIR ? path.resolve(process.env.CRM_DATA_DIR) : path.join(ROOT, 'data');
const OUT_DIR = path.join(DATA, 'slack', 'messages');
const SOURCES_PATH = path.join(DATA, 'sources.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maxSlackTs(values) {
  let best = null;
  for (const value of values || []) {
    const ts = String(value || '');
    if (!ts) continue;
    if (!best || ts.localeCompare(best) > 0) best = ts;
  }
  return best;
}

function getSlackSource() {
  const sources = readJson(SOURCES_PATH, {});
  return sources.slack || {};
}

function getToken(slack) {
  return process.env.SLACK_USER_TOKEN
    || process.env.SLACK_ACCESS_TOKEN
    || slack.authedUserAccessToken
    || process.env.SLACK_BOT_TOKEN
    || slack.botAccessToken
    || null;
}

const sourceSafety = buildSafetyConfig('slack', process.env, {
  defaultMaxApiCalls: 300,
  unsafeMaxApiCalls: 3000,
  defaultDelayMs: 1500,
  unsafeDelayMs: 250,
});

const cfg = {
  safeMode: sourceSafety.safeMode,
  includeThreads: envBool('SLACK_INCLUDE_THREADS', process.env, false),
  channelLimit: envInt('SLACK_MESSAGE_CHANNEL_LIMIT', process.env, sourceSafety.safeMode ? 25 : 250, 1),
  messageLimitPerChannel: envInt('SLACK_MESSAGE_LIMIT_PER_CHANNEL', process.env, sourceSafety.safeMode ? 200 : 2000, 1),
  pageLimit: envInt('SLACK_MESSAGE_PAGE_LIMIT', process.env, 100, 1),
  threadLimitPerChannel: envInt('SLACK_THREAD_LIMIT_PER_CHANNEL', process.env, sourceSafety.safeMode ? 10 : 100, 0),
  apiDelayMs: sourceSafety.delayMs,
  channelDelayMs: envInt('SLACK_CHANNEL_DELAY_MS', process.env, sourceSafety.safeMode ? 2500 : 500, 0),
  maxApiCalls: sourceSafety.maxApiCalls,
  channelFilter: (process.env.SLACK_MESSAGE_CHANNEL_FILTER || '').split(',').map(s => s.trim()).filter(Boolean),
  oldest: process.env.SLACK_MESSAGE_OLDEST || undefined,
  latest: process.env.SLACK_MESSAGE_LATEST || undefined,
  incremental: sourceSafety.incremental,
};

let apiCallCount = 0;

async function slackApi(method, params, token) {
  if (apiCallCount >= cfg.maxApiCalls) {
    const err = new Error('SLACK_MAX_API_CALLS reached');
    err.code = 'max_api_calls';
    throw err;
  }
  apiCallCount += 1;
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    const retry = Math.max(1, Number.parseInt(res.headers.get('retry-after') || '1', 10));
    await sleep((retry + 2) * 1000);
    return slackApi(method, params, token);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(json.error || `Slack API ${method} failed`);
    err.code = json.error || 'slack_error';
    throw err;
  }
  if (cfg.apiDelayMs) await sleep(cfg.apiDelayMs);
  return json;
}

function slimMessage(msg, channel) {
  const ts = String(msg.ts || '');
  const user = msg.user || msg.bot_id || msg.username || null;
  return {
    id: `${channel.id}:${ts}`,
    type: msg.thread_ts && msg.thread_ts !== msg.ts ? 'thread_reply' : 'message',
    subtype: msg.subtype || null,
    ts,
    timestamp: ts ? new Date(Number(ts.split('.')[0]) * 1000).toISOString() : null,
    user,
    text: typeof msg.text === 'string' ? msg.text : '',
    channelId: channel.id,
    channelName: channel.name || null,
    isPrivate: !!channel.is_private,
    thread_ts: msg.thread_ts || null,
    reply_count: msg.reply_count || 0,
    reply_users_count: msg.reply_users_count || 0,
    reactions: Array.isArray(msg.reactions) ? msg.reactions.map(r => ({ name: r.name, count: r.count })) : [],
    files: Array.isArray(msg.files) ? msg.files.map(f => ({ id: f.id || null, mimetype: f.mimetype || null, filetype: f.filetype || null })) : [],
  };
}

async function listChannels(token) {
  const channels = [];
  let cursor;
  do {
    const page = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: Math.min(1000, Math.max(1, cfg.pageLimit)),
      cursor,
    }, token);
    channels.push(...(page.channels || []));
    cursor = page.response_metadata && page.response_metadata.next_cursor;
  } while (cursor && apiCallCount < cfg.maxApiCalls);

  let filtered = channels;
  if (cfg.channelFilter.length) {
    const wanted = new Set(cfg.channelFilter);
    filtered = filtered.filter(c => wanted.has(c.id) || wanted.has(c.name));
  }
  return filtered.slice(0, cfg.channelLimit);
}

async function historyForChannel(token, channel, previousLatestTs) {
  const messages = [];
  const inaccessible = [];
  let cursor;
  const oldest = cfg.oldest || (cfg.incremental ? previousLatestTs : undefined);
  try {
    do {
      const page = await slackApi('conversations.history', {
        channel: channel.id,
        limit: Math.min(cfg.pageLimit, cfg.messageLimitPerChannel - messages.length),
        cursor,
        oldest,
        latest: cfg.latest,
      }, token);
      messages.push(...(page.messages || []).map(m => slimMessage(m, channel)));
      cursor = page.response_metadata && page.response_metadata.next_cursor;
    } while (cursor && messages.length < cfg.messageLimitPerChannel && apiCallCount < cfg.maxApiCalls);

    if (cfg.includeThreads && cfg.threadLimitPerChannel > 0) {
      const threaded = messages.filter(m => m.reply_count > 0 && m.thread_ts !== null).slice(0, cfg.threadLimitPerChannel);
      const seen = new Set(messages.map(m => m.id));
      for (const parent of threaded) {
        if (apiCallCount >= cfg.maxApiCalls) break;
        try {
          const replies = await slackApi('conversations.replies', {
            channel: channel.id,
            ts: parent.thread_ts || parent.ts,
            limit: Math.min(cfg.pageLimit, cfg.messageLimitPerChannel),
          }, token);
          for (const reply of replies.messages || []) {
            if (reply.ts === parent.ts) continue;
            const slim = slimMessage(reply, channel);
            if (!seen.has(slim.id)) {
              seen.add(slim.id);
              messages.push(slim);
            }
          }
        } catch (err) {
          inaccessible.push({ channelId: channel.id, stage: 'thread', error: err.code || 'error' });
        }
      }
    }
  } catch (err) {
    inaccessible.push({ channelId: channel.id, stage: 'history', error: err.code || 'error' });
  }
  return { messages, inaccessible };
}

async function main() {
  const slack = getSlackSource();
  const token = getToken(slack);
  if (!token) {
    console.error('Slack is not connected locally. Re-authorize Slack before importing messages.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const existing = readJson(path.join(OUT_DIR, 'messages.json'), []);
  const existingById = new Map(Array.isArray(existing) ? existing.map(m => [m.id, m]) : []);
  const latestByChannel = new Map();
  for (const msg of existingById.values()) {
    if (!msg || !msg.channelId) continue;
    const best = maxSlackTs([latestByChannel.get(msg.channelId), msg.ts]);
    if (best) latestByChannel.set(msg.channelId, best);
  }
  const channels = await listChannels(token);
  const fetched = [];
  const inaccessible = [];
  for (const channel of channels) {
    if (apiCallCount >= cfg.maxApiCalls) break;
    const result = await historyForChannel(token, channel, latestByChannel.get(channel.id));
    fetched.push(...result.messages);
    inaccessible.push(...result.inaccessible);
    if (cfg.channelDelayMs) await sleep(cfg.channelDelayMs);
  }

  const merged = new Map(existingById);
  for (const msg of fetched) merged.set(msg.id, msg);
  const all = [...merged.values()];
  all.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  writeJson(path.join(OUT_DIR, 'messages.json'), all);
  fs.writeFileSync(path.join(OUT_DIR, 'index.jsonl'), all.map(m => JSON.stringify(m)).join('\n') + (all.length ? '\n' : ''));

  const byChannel = new Map();
  for (const m of all) byChannel.set(m.channelId, (byChannel.get(m.channelId) || 0) + 1);
  const meta = {
    workspace: slack.workspace || null,
    workspaceId: slack.workspaceId || null,
    importedAt: new Date().toISOString(),
    totalMessages: all.length,
    fetchedMessages: fetched.length,
    previousMessages: existingById.size,
    newMessages: Math.max(0, all.length - existingById.size),
    successfulChannelCount: [...byChannel.keys()].length,
    totalChannelCount: channels.length,
    inaccessibleChannelCount: inaccessible.length,
    includeThreads: cfg.includeThreads,
    safeMode: cfg.safeMode,
    pageLimit: cfg.pageLimit,
    apiCallCount,
    maxApiCalls: cfg.maxApiCalls,
    channelLimit: cfg.channelLimit,
    messageLimitPerChannel: cfg.messageLimitPerChannel,
    threadLimitPerChannel: cfg.threadLimitPerChannel,
    incremental: cfg.incremental,
    oldestStrategy: cfg.oldest ? 'env' : (cfg.incremental ? 'per_channel_latest_ts' : 'none'),
    apiDelayMs: cfg.apiDelayMs,
    channelDelayMs: cfg.channelDelayMs,
    errors: inaccessible.reduce((acc, e) => { acc[e.error] = (acc[e.error] || 0) + 1; return acc; }, {}),
  };
  writeJson(path.join(OUT_DIR, 'meta.json'), meta);

  const sources = readJson(SOURCES_PATH, {});
  sources.slack = {
    ...(sources.slack || {}),
    messagesSyncedAt: meta.importedAt,
    messageCount: meta.totalMessages,
    messageChannelCount: meta.successfulChannelCount,
    messageInaccessibleChannelCount: meta.inaccessibleChannelCount,
  };
  writeJson(SOURCES_PATH, sources);

  console.log(JSON.stringify({
    slack: {
      totalMessages: meta.totalMessages,
      fetchedMessages: meta.fetchedMessages,
      previousMessages: meta.previousMessages,
      newMessages: meta.newMessages,
      successfulChannels: meta.successfulChannelCount,
      totalChannels: meta.totalChannelCount,
      inaccessibleChannels: meta.inaccessibleChannelCount,
      includeThreads: meta.includeThreads,
      safeMode: meta.safeMode,
      apiCallCount: meta.apiCallCount,
      maxApiCalls: meta.maxApiCalls,
      incremental: meta.incremental,
      oldestStrategy: meta.oldestStrategy,
    }
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(JSON.stringify({ error: err.code || 'slack_import_failed' }));
    process.exit(1);
  });
}

module.exports = { slimMessage, envInt, envBool, maxSlackTs };

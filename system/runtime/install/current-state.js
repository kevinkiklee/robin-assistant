// current-state.js — read latest cached integration rows from the events
// table and render a compact "current state" block for injection into
// CLAUDE.md / GEMINI.md. Lets the agent ground answers about sleep,
// recovery, and weather without an extra integration_run round-trip — and
// without asking the user permission to read their own data.
//
// Scope is deliberately small: a few high-leverage integrations that
// commonly come up in conversational context (body state, weather). Adding
// more is fine, but each new row adds tokens to every agent turn, so prefer
// signal density over comprehensiveness.

import { BoundQuery } from 'surrealdb';

const CURRENT_STATE_START = '<!-- robin-current-state:start (auto-generated, refreshed hourly) -->';
const CURRENT_STATE_END = '<!-- robin-current-state:end -->';

async function latestEvent(db, where) {
  const sql = `SELECT id, content, ts, meta FROM events ${where} ORDER BY ts DESC LIMIT 1`;
  try {
    const [rows] = await db.query(new BoundQuery(sql, {})).collect();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

async function latestWhoopByKind(db, kind) {
  const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'whoop' AND meta.kind = $kind ORDER BY ts DESC LIMIT 1`;
  try {
    const [rows] = await db.query(new BoundQuery(sql, { kind })).collect();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function readCurrentState(db) {
  if (!db) return { sleep: null, recovery: null, weather: null };
  const [sleep, recovery, weather] = await Promise.all([
    latestWhoopByKind(db, 'sleep'),
    latestWhoopByKind(db, 'recovery'),
    latestEvent(db, "WHERE source = 'weather'"),
  ]);
  return { sleep, recovery, weather };
}

function fmtTs(ts) {
  if (!ts) return 'unknown';
  try {
    return new Date(ts).toISOString();
  } catch {
    return 'unknown';
  }
}

function sleepLine(sleep) {
  if (!sleep) return 'Sleep: (no recent record — Whoop strap off, or sync gap)';
  const napFlag = sleep.meta?.nap ? ' [NAP]' : '';
  const perf = sleep.meta?.score?.sleep_performance_percentage;
  const perfStr = perf == null ? '' : ` · perf ${perf}%`;
  const end = fmtTs(sleep.meta?.end ?? sleep.ts);
  return `Sleep last cycle${napFlag}: ${sleep.content}${perfStr} (ended ${end})`;
}

function recoveryLine(recovery) {
  if (!recovery) return 'Recovery: (no recent record)';
  const ts = fmtTs(recovery.ts);
  return `${recovery.content} (${ts})`;
}

function weatherLine(weather) {
  if (!weather) return 'Weather: (no recent record)';
  const ts = fmtTs(weather.ts);
  return `Weather: ${weather.content} (${ts})`;
}

export function currentStateSection(state) {
  const s = state ?? { sleep: null, recovery: null, weather: null };
  const body = `## Current state (auto-injected — read before answering body/weather/context questions)

${sleepLine(s.sleep)}
${recoveryLine(s.recovery)}
${weatherLine(s.weather)}

This block is the agent's ground truth for body- and weather-coupled questions
(sleep, fatigue, headache, mood, dressing, outdoor plans). Do NOT ask the
user permission to check Whoop or weather — the cached values are right here.
If a timestamp is older than 2× the integration cadence (Whoop 30m, weather
6h), refresh via \`integration_run({name})\` before quoting as "current"; do
not paper over a gap with the stale value.`;

  return `${CURRENT_STATE_START}
${body}
${CURRENT_STATE_END}`;
}

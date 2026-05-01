// system/scripts/lib/turn-state.js
//
// Per-turn state helpers used by the capture-enforcement hooks.
// All writes are atomic where corruption could mislead Stop verification.

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TURN_FILE = 'user-data/state/turn.json';
const WRITES_LOG = 'user-data/state/turn-writes.log';
const RETRY_FILE = 'user-data/state/capture-retry.json';

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function atomicWrite(file, content) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function mintTurnId(sessionId, when = new Date()) {
  return `${sessionId}:${when.getTime()}`;
}

export function writeTurnJson(workspaceDir, obj) {
  const file = join(workspaceDir, TURN_FILE);
  const payload = { ...obj, started_at: obj.started_at ?? new Date().toISOString() };
  atomicWrite(file, JSON.stringify(payload));
}

export function readTurnJson(workspaceDir) {
  const file = join(workspaceDir, TURN_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function appendWriteIntent(workspaceDir, { turn_id, target, tool }) {
  const file = join(workspaceDir, WRITES_LOG);
  ensureDir(file);
  const ts = new Date().toISOString();
  appendFileSync(file, `${ts}\t${turn_id}\t${target}\t${tool}\n`);
}

export function readWriteIntents(workspaceDir, turnId) {
  const file = join(workspaceDir, WRITES_LOG);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [ts, tid, target, tool] = line.split('\t');
    if (tid === turnId) out.push({ ts, turn_id: tid, target, tool });
  }
  return out;
}

export function pruneWriteIntents(workspaceDir, cutoff = new Date(Date.now() - 3600_000)) {
  const file = join(workspaceDir, WRITES_LOG);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const cutoffMs = cutoff.getTime();
  const kept = lines.filter((line) => {
    const ts = line.split('\t')[0];
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  atomicWrite(file, kept.length ? kept.join('\n') + '\n' : '');
}

function readRetryFile(workspaceDir) {
  const file = join(workspaceDir, RETRY_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function readRetry(workspaceDir, turnId) {
  const data = readRetryFile(workspaceDir);
  return data[turnId]?.attempts ?? 0;
}

export function incrementRetry(workspaceDir, turnId) {
  const file = join(workspaceDir, RETRY_FILE);
  const data = readRetryFile(workspaceDir);
  const cur = data[turnId]?.attempts ?? 0;
  data[turnId] = { attempts: cur + 1, last_at: new Date().toISOString() };
  atomicWrite(file, JSON.stringify(data));
  return cur + 1;
}

// Cycle-2c: high-stakes write audit log.
//
// Distinct from policy-refusals.log — high-stakes-writes.log is for
// retrospective audit (what files were touched), not blocked attacks.
// Format: timestamp \t target \t content-hash. Dedup 1h window on
// (target, content-hash) so active editing doesn't spam.
//
// Surfaced in morning briefing aggregated by destination.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LOG_REL = 'user-data/state/high-stakes-writes.log';
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

function logPath(workspaceDir) {
  return join(workspaceDir, LOG_REL);
}

function recentEntriesMap(workspaceDir, windowMs) {
  const p = logPath(workspaceDir);
  if (!existsSync(p)) return new Map();
  const tail = readFileSync(p, 'utf-8');
  const cutoff = Date.now() - windowMs;
  const out = new Map();  // key=`${target}\t${hash}` → timestamp
  for (const line of tail.split('\n')) {
    if (!line) continue;
    const [ts, target, hash] = line.split('\t');
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    if (t < cutoff) continue;
    out.set(`${target}\t${hash ?? ''}`, t);
  }
  return out;
}

export function appendHighStakesWrite(workspaceDir, { target, contentHash }) {
  const recent = recentEntriesMap(workspaceDir, DEDUP_WINDOW_MS);
  if (recent.has(`${target}\t${contentHash ?? ''}`)) return;  // dedup
  const p = logPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(p, `${ts}\t${target}\t${contentHash ?? ''}\n`, { flag: 'a' });
}

export const HIGH_STAKES_DESTINATIONS = [
  'user-data/memory/tasks.md',
  'user-data/memory/decisions.md',
  'user-data/memory/self-improvement/corrections.md',
  'user-data/memory/self-improvement/patterns.md',
  'user-data/memory/self-improvement/preferences.md',
  'user-data/memory/self-improvement/communication-style.md',
  'user-data/memory/profile/identity.md',
];

export function isHighStakesDestination(target) {
  if (typeof target !== 'string') return false;
  const norm = target.replace(/\\/g, '/');
  return HIGH_STAKES_DESTINATIONS.some((p) => norm === p || norm.endsWith('/' + p));
}

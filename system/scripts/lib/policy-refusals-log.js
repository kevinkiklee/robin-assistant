// Policy refusals log — append-only TSV at user-data/runtime/state/telemetry/policy-refusals.log.
//
// Used by cycle-1b (outbound policy), cycle-2a (bash hook), cycle-2b (tamper
// detection), cycle-2c (PII write hook). Each entry has:
//   timestamp \t kind \t target \t layer \t reason \t content-hash
//
// kind     - 'outbound' | 'bash' | 'tamper' | 'pii-bypass' | future kinds.
// target   - tool target string (e.g., 'github:owner/repo', 'local-bash', 'discord:dm:USERID').
// layer    - per-cycle layer identifier ('1'/'2'/'3' for outbound; 'pattern'/'hook-internal-error' for bash; 'severe'/'mild'/'info' for tamper).
// reason   - human-readable, <120 chars.
// content-hash - FNV-1a-64 hex of the refused content (16 chars), or '' for tamper events without content.
//
// Rotation at 1MB: oldest log is moved to user-data/runtime/state/telemetry/policy-refusals-YYYY-MM.log
// keyed by the month of the first entry in the rolled file.

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROTATE_BYTES = 1024 * 1024;  // 1MB
const LOG_REL = 'user-data/runtime/state/telemetry/policy-refusals.log';

function logPath(workspaceDir) {
  return join(workspaceDir, LOG_REL);
}

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

function escapeField(s) {
  return String(s ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ');
}

function rotateIfLarge(workspaceDir) {
  const p = logPath(workspaceDir);
  if (!existsSync(p)) return;
  const size = statSync(p).size;
  if (size < ROTATE_BYTES) return;

  // Find the month of the first entry in the file.
  let monthTag;
  try {
    const head = readFileSync(p, 'utf-8').slice(0, 256);
    const firstLine = head.split('\n')[0];
    const ts = firstLine.split('\t')[0];
    const m = ts.match(/^(\d{4})-(\d{2})/);
    monthTag = m ? `${m[1]}-${m[2]}` : new Date().toISOString().slice(0, 7);
  } catch {
    monthTag = new Date().toISOString().slice(0, 7);
  }
  const archive = join(workspaceDir, `user-data/runtime/state/telemetry/policy-refusals-${monthTag}.log`);
  if (existsSync(archive)) {
    // Append to existing archive instead of overwriting.
    const existing = readFileSync(p, 'utf-8');
    writeFileSync(archive, existing, { flag: 'a' });
    writeFileSync(p, '');
  } else {
    renameSync(p, archive);
  }
}

export function appendPolicyRefusal(workspaceDir, { kind, target, layer, reason, contentHash }) {
  const p = logPath(workspaceDir);
  ensureDir(p);
  rotateIfLarge(workspaceDir);
  const ts = new Date().toISOString();
  const line = [ts, kind, target, layer, reason, contentHash ?? '']
    .map(escapeField)
    .join('\t') + '\n';
  writeFileSync(p, line, { flag: 'a' });
}

// Read the tail of the log (~10KB by default), filter by kind + window, and
// return a Set of contentHash values. Used for dedup checks before appending.
export function readRecentRefusalHashes(workspaceDir, kind, windowMs, { tailBytes = 10 * 1024 } = {}) {
  const p = logPath(workspaceDir);
  if (!existsSync(p)) return new Set();
  const stat = statSync(p);
  const start = Math.max(0, stat.size - tailBytes);
  const buf = readFileSync(p, 'utf-8').slice(start);
  // Drop a possibly-truncated first line.
  const lines = buf.split('\n').filter(Boolean);
  if (start > 0 && lines.length > 0) lines.shift();

  const cutoff = Date.now() - windowMs;
  const out = new Set();
  for (const line of lines) {
    const [ts, lkind, , , , hash] = line.split('\t');
    if (lkind !== kind) continue;
    if (!hash) continue;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    if (t < cutoff) continue;
    out.add(hash);
  }
  return out;
}

export const __test__ = { logPath, rotateIfLarge, ROTATE_BYTES };

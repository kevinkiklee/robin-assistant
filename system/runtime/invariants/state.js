// Atomic read/write of invariants-state.json.
//
// Schema: { invariants: { [name]: PerInvariantState }, generated_at: iso8601 }
//
// Resilient reads: missing/corrupt file → empty state (re-run everything).
// Atomic writes: tmpfile + rename.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const REPAIR_HISTORY_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyState() {
  return { invariants: {}, generated_at: null };
}

export function emptyEntry() {
  return {
    last_checked_at: null,
    last_pass_at: null,
    last_failure_at: null,
    last_repair_at: null,
    last_repair_outcome: null,
    consecutive_failures: 0,
    pending_repair_at: null,
    last_result_summary: null,
    repair_history_30d: [],
  };
}

export function readState(path) {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.invariants) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = { ...state, generated_at: new Date().toISOString() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, path);
}

export function getEntry(state, name) {
  return state.invariants[name] ?? emptyEntry();
}

export function setEntry(state, name, entry) {
  state.invariants[name] = entry;
}

export function pruneRepairHistory(history, now = Date.now()) {
  const cutoff = now - REPAIR_HISTORY_RETAIN_MS;
  return history.filter((ts) => ts > cutoff);
}

export function recordCheckResult(entry, result, now = Date.now()) {
  const next = { ...entry, last_checked_at: now };
  next.last_result_summary = result;
  if (result.ok) {
    next.last_pass_at = now;
    next.consecutive_failures = 0;
    next.pending_repair_at = null;
  } else {
    next.last_failure_at = now;
    next.consecutive_failures = entry.consecutive_failures + 1;
  }
  return next;
}

export function recordRepairResult(entry, repair, now = Date.now()) {
  const next = { ...entry, last_repair_at: now };
  next.last_repair_outcome = repair.repaired ? 'succeeded' : repair.error ? 'failed' : 'skipped';
  next.pending_repair_at = null;
  if (repair.repaired) {
    next.repair_history_30d = pruneRepairHistory([...entry.repair_history_30d, now], now);
  }
  return next;
}

export function resetFailureCount(entry) {
  return { ...entry, consecutive_failures: 0 };
}

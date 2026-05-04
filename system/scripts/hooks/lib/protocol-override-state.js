// Per-session state I/O for the pre-protocol-override hook.
//
// State file path: <workspace>/user-data/runtime/state/protocol-overrides/<session_id>.json
//
// Schema:
//   {
//     "session_id": "<id>",
//     "turn_started_at": "2026-05-03T...",
//     "triggers_fired": ["daily-briefing"],
//     "overrides_read": []
//   }
//
// All writes use atomic tmp+rename so a crash mid-write leaves prior state
// intact. State is overwritten on every UserPromptSubmit (always-overwrite
// semantics — required to avoid stale-state false blocks). PreToolUse
// mutations use read-modify-atomic-write.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

export const STATE_DIR_REL = 'user-data/runtime/state/protocol-overrides';
// 24 hours — beyond this, PreToolUse treats the file as no-state (allow).
export const STATE_STALE_MS = 24 * 60 * 60 * 1000;

export function stateFilePath(workspace, sessionId) {
  // Sanitize session id to avoid path traversal — defensive even though
  // session ids come from Claude Code's own event payload.
  const safe = String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(workspace, STATE_DIR_REL, `${safe}.json`);
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function readState(workspace, sessionId) {
  const path = stateFilePath(workspace, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Corrupt file → fail-open (treat as no state).
    return null;
  }
}

// Atomic write: tmp file in the same directory + rename. Throws on failure
// so the caller can fall back to delete+telemetry.
export function writeState(workspace, sessionId, state) {
  const path = stateFilePath(workspace, sessionId);
  ensureDir(path);
  // Use a unique tmp suffix so concurrent writes for distinct sessions never
  // collide. Process pid + hi-res ts is sufficient.
  const tmp = `${path}.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

// Best-effort delete — used by the hook when writeState fails to ensure
// PreToolUse falls into the no-state allow path (rather than acting on
// stale prior-turn state). Returns true if the file is gone after the call.
export function deleteState(workspace, sessionId) {
  const path = stateFilePath(workspace, sessionId);
  if (!existsSync(path)) return true;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// Read-modify-atomic-write: append `protocol` to overrides_read (if not
// already present). No-op if state file is missing or unreadable.
export function markOverrideRead(workspace, sessionId, protocol) {
  const state = readState(workspace, sessionId);
  if (!state) return false;
  if (!Array.isArray(state.overrides_read)) state.overrides_read = [];
  if (state.overrides_read.includes(protocol)) return true;
  state.overrides_read.push(protocol);
  writeState(workspace, sessionId, state);
  return true;
}

// True if file is missing or older than STATE_STALE_MS.
export function isStateStale(path) {
  if (!existsSync(path)) return true;
  let st;
  try {
    st = statSync(path);
  } catch {
    return true;
  }
  return (Date.now() - st.mtimeMs) > STATE_STALE_MS;
}

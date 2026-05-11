// SessionStart hook handler (Phase 4a §5.E + §6).
//
// Hook contract (Claude Code SessionStart, current shape):
//   stdin JSON has shape { session_id, transcript_path, ... }
//
// We POST to the daemon at /internal/session/register so the registry +
// any cached tamper-state warnings can be returned. The daemon endpoint
// itself is added by another agent in this wave; until it lands the
// handler exits 0 silently because every failure path here is fail-soft.
//
// Responsibilities:
//   - Detect host from environment (Claude Code sets CLAUDECODE=1, Gemini
//     CLI surfaces GEMINI_CLI; otherwise we report 'unknown').
//   - POST to the daemon with a 1s hard timeout.
//   - On success, surface any session_count > 1 message and tamper warnings.
//   - On any failure (no daemon state, daemon down, timeout, non-2xx), exit 0.

import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { paths } from '../../runtime/data-store.js';

function detectHost() {
  if (process.env.CLAUDECODE === '1') return 'claude-code';
  if (process.env.CLAUDE_CODE) return 'claude-code';
  if (process.env.GEMINI_CLI) return 'gemini-cli';
  return 'unknown';
}

function pickSessionId(stdin) {
  if (!stdin || typeof stdin !== 'object') return undefined;
  const a = stdin.session_id ?? stdin.sessionId;
  return typeof a === 'string' && a.length > 0 ? a : undefined;
}

function pickTranscriptPath(stdin) {
  if (!stdin || typeof stdin !== 'object') return undefined;
  const a = stdin.transcript_path ?? stdin.transcriptPath;
  return typeof a === 'string' && a.length > 0 ? a : undefined;
}

/**
 * SessionStart handler.
 *
 * @param {object} args
 * @param {object} [args.stdin]   Parsed hook payload.
 * @param {(s: string) => void} [args.stderr]  One-line stderr writer
 *   (handler appends the trailing newline). Defaults to process.stderr.
 * @param {() => Promise<{port:number, pid?:number}|null>} [args.readState]
 *   Override for daemon-state lookup (used in tests).
 * @param {typeof fetch} [args.fetchFn]  Override for fetch (used in tests).
 */
export async function sessionStartHandler({ stdin, stderr, readState, fetchFn } = {}) {
  const writeErr = typeof stderr === 'function' ? stderr : (s) => process.stderr.write(`${s}\n`);
  const doFetch = typeof fetchFn === 'function' ? fetchFn : fetch;

  const sessionId = pickSessionId(stdin);
  if (!sessionId) {
    // Nothing to register. Fail-soft.
    return;
  }
  const transcriptPath = pickTranscriptPath(stdin);
  const host = detectHost();

  let state = null;
  try {
    if (typeof readState === 'function') {
      state = await readState();
    } else {
      state = await readDaemonState(paths.data.daemonState());
    }
  } catch {
    return;
  }
  if (!state || typeof state.port !== 'number') return;
  // If daemon state is stale (PID dead), don't bother trying.
  if (typeof state.pid === 'number' && !isPidAlive(state.pid)) return;

  const body = {
    session_id: sessionId,
    host,
    pid: process.pid,
    transcript_path: transcriptPath,
  };

  let res;
  try {
    res = await doFetch(`http://127.0.0.1:${state.port}/internal/session/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    return;
  }
  if (!res || !res.ok) return;

  let payload;
  try {
    payload = await res.json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  const count = Number.isInteger(payload.session_count) ? payload.session_count : 0;
  if (count > 1) {
    writeErr(`Robin: session ${count} of ${count}`);
  }
  const findings = Array.isArray(payload.tamper_findings) ? payload.tamper_findings : [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const kind = typeof f.kind === 'string' ? f.kind : 'unknown';
    const path = typeof f.path === 'string' ? f.path : '?';
    writeErr(`Robin: tamper warning — ${kind}: ${path}`);
  }
}

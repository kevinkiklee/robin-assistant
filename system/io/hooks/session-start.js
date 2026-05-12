// SessionStart hook handler (Phase 4a §5.E + §6).
//
// Hook contract (Claude Code SessionStart, current shape):
//   stdin JSON has shape { session_id, transcript_path, ... }
//
// We POST to the daemon at /internal/session/register so the registry +
// any cached introspection-state warnings can be returned. Every failure
// path here is fail-soft so the host's session starts even if Robin is
// unavailable.

import { readDaemonState } from '../../config/daemon-state.js';
import { paths } from '../../config/data-store.js';
import { isPidAlive } from '../../runtime/daemon/lock.js';

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
    const headers = { 'content-type': 'application/json' };
    if (state.auth_token) headers.authorization = `Bearer ${state.auth_token}`;
    res = await doFetch(`http://127.0.0.1:${state.port}/internal/session/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    return;
  }
  if (!res?.ok) return;

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
  const findings = Array.isArray(payload.introspection_findings)
    ? payload.introspection_findings
    : [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const kind = typeof f.kind === 'string' ? f.kind : 'unknown';
    const path = typeof f.path === 'string' ? f.path : '?';
    writeErr(`Robin: introspection warning — ${kind}: ${path}`);
  }
}

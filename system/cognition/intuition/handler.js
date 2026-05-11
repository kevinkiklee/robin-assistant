// UserPromptSubmit hook handler — intuition.
//
// Cutover suppression: if v1 hooks are still active in this project
// (`$CLAUDE_PROJECT_DIR/system/scripts/hooks/host-hook.js` exists), yield
// silently with a one-line stderr notice. Avoids double
// `<!-- relevant memory -->` blocks from two different DBs.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonState } from '../../config/daemon-state.js';
import { paths } from '../../config/data-store.js';
import { readFileTail } from '../../config/file-tail.js';

const TRANSCRIPT_TAIL_BYTES = 8 * 1024;
const PRIOR_ASSISTANT_CAP = 2000;
const FETCH_TIMEOUT_MS = 300;

function pickQuery(stdin) {
  if (!stdin || typeof stdin !== 'object') return '';
  const a = stdin.prompt ?? stdin.user_message ?? stdin.message;
  return typeof a === 'string' ? a : '';
}

function pickTranscriptPath(stdin) {
  if (!stdin || typeof stdin !== 'object') return '';
  const a = stdin.transcript_path ?? stdin.transcriptPath;
  return typeof a === 'string' ? a : '';
}

function pickSessionId(stdin) {
  if (!stdin || typeof stdin !== 'object') return undefined;
  const a = stdin.session_id ?? stdin.sessionId;
  return typeof a === 'string' && a.length > 0 ? a : undefined;
}

// Concatenate the textual portions of an assistant message's `content`
// field. Claude Code transcripts use either a bare string or an array of
// `{type:'text', text:...}` blocks (mixed with tool_use / tool_result).
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string'
      ) {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

// Find the most recent assistant message in a JSONL tail. Drops the first
// (likely partial) line because we may have read mid-line.
function findLastAssistantText(tail) {
  if (typeof tail !== 'string' || tail.length === 0) return '';
  const lines = tail.split('\n');
  // Drop the leading possibly-partial fragment unless it's the only line.
  const usable = lines.length > 1 ? lines.slice(1) : lines;
  for (let i = usable.length - 1; i >= 0; i--) {
    const line = usable[i].trim();
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Claude Code stores either {role, content} or {type:'assistant', message:{role, content}}.
    const role = obj?.role ?? obj?.message?.role;
    if (role !== 'assistant') continue;
    const content = obj?.content ?? obj?.message?.content;
    const text = extractAssistantText(content);
    if (text) return text;
  }
  return '';
}

function readPriorAssistant(transcriptPath) {
  if (!transcriptPath) return '';
  const tail = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!tail) return '';
  const text = findLastAssistantText(tail);
  if (!text) return '';
  return text.length > PRIOR_ASSISTANT_CAP ? text.slice(0, PRIOR_ASSISTANT_CAP) : text;
}

/**
 * Resolve the agent-host source for the focus block (spec §4.2 step 1).
 *
 * Priority: ROBIN_SOURCE env → CLAUDE_PROJECT_DIR (→ agent:claude-code) →
 * GEMINI_CLI_SESSION (→ agent:gemini-cli) → null. The daemon performs
 * additional fallback (host?.name → most-recently-active episode lookup);
 * the handler stays additive.
 */
export function resolveSourceForHandler({ env = process.env } = {}) {
  const explicit = env.ROBIN_SOURCE;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.length > 0) {
    return 'agent:claude-code';
  }
  if (typeof env.GEMINI_CLI_SESSION === 'string' && env.GEMINI_CLI_SESSION.length > 0) {
    return 'agent:gemini-cli';
  }
  return null;
}

// Detect a still-active v1 hooks installation. We're conservative: only
// the canonical v1 entrypoint counts, and only when CLAUDE_PROJECT_DIR
// (set by Claude Code per project) names a directory containing it.
function v1HooksActive() {
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (!dir || typeof dir !== 'string') return false;
  try {
    return existsSync(join(dir, 'system/scripts/hooks/host-hook.js'));
  } catch {
    return false;
  }
}

/**
 * UserPromptSubmit handler.
 *
 * @param {object} args
 * @param {object} [args.stdin]   Parsed hook payload.
 * @param {(s: string) => void} [args.stdout]
 *   Injected stdout writer (defaults to process.stdout.write). Anything
 *   written is fed by Claude Code into the model's context as additional
 *   context.
 * @param {(s: string) => void} [args.stderr]
 *   One-line stderr writer (handler appends the trailing newline).
 * @param {() => Promise<{port:number, pid?:number}|null>} [args.readState]
 *   Override for daemon-state lookup (used in tests).
 * @param {typeof fetch} [args.fetchFn]  Override for fetch (used in tests).
 */
export async function intuitionHandler({ stdin, stdout, stderr, readState, fetchFn } = {}) {
  const writeOut = typeof stdout === 'function' ? stdout : (s) => process.stdout.write(s);
  const writeErr = typeof stderr === 'function' ? stderr : (s) => process.stderr.write(`${s}\n`);
  const doFetch = typeof fetchFn === 'function' ? fetchFn : fetch;

  // Cutover suppression: if v1 hooks are also installed, yield this turn.
  if (v1HooksActive()) {
    writeErr('Robin: v1 hooks active in this project; v2 intuition yielding.');
    return;
  }

  const query = pickQuery(stdin);
  const sessionId = pickSessionId(stdin);
  const source = resolveSourceForHandler();
  const transcriptPath = pickTranscriptPath(stdin);
  const priorAssistant = readPriorAssistant(transcriptPath);

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

  let res;
  try {
    res = await doFetch(`http://127.0.0.1:${state.port}/internal/intuition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        session_id: sessionId,
        source,
        prior_assistant: priorAssistant,
        k: 6,
        recency_days: 30,
        token_budget: 1500,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

  const block = typeof payload.block === 'string' ? payload.block : '';
  const focusBlock = typeof payload.focus_block === 'string' ? payload.focus_block : '';
  // Focus block (current focus) goes first, before the relevant-memory block.
  const combined = `${focusBlock}${block}`;
  if (combined.length > 0) {
    writeOut(combined);
  }
}

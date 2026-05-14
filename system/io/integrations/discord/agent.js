import { spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package root — the directory that holds `.mcp.json` and `CLAUDE.md`.
// Spawning the agent here means claude picks up the robin MCP server and the
// project-level instructions automatically, so the bot inherits Robin's full
// tool surface (recall, get_knowledge, integrations, daily-brief workflow, …).
//
// agent.js lives at system/io/integrations/discord/agent.js — five segments
// (agent.js + discord + integrations + io + system) below the package root.
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

const DEFAULT_MAX_TURNS = 20;
// 15 min covers thorough investigations (systematic-debugging, daily-brief
// recomposition, multi-integration queries). Discord has no inbound deadline;
// the typing indicator refreshes every 7s so the user sees the bot still
// working. Override with `ROBIN_DISCORD_AGENT_TIMEOUT_MS` (ms) if needed.
const FALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
function envTimeoutMs() {
  const raw = process.env.ROBIN_DISCORD_AGENT_TIMEOUT_MS;
  if (!raw) return FALLBACK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_TIMEOUT_MS;
}
const SIGKILL_DELAY_MS = 5000; // grace period after SIGTERM

function buildArgs({ prompt, sessionId, maxTurns }) {
  // Claude Code v2.x: `-p` is print mode; `--max-turns` caps the agent loop;
  // `--output-format json` returns a single envelope `{ result, session_id,
  // total_cost_usd, is_error, subtype }`. `--resume <id>` continues a prior
  // session so multi-turn context (and Claude's own context cache) carry over.
  const base = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns)];
  return sessionId ? ['--resume', sessionId, ...base] : base;
}

// Spawn the agent in detached mode + own process group so SIGTERM/SIGKILL on
// the group reliably kills any tool subprocesses the agent forked.
function killTree(child, signal) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead.
    }
  }
}

function parseEnvelope(stdout) {
  // `--output-format json` emits the envelope as a single JSON object. Some
  // older builds wrapped it in an array; handle both. Falls back to scanning
  // stdout from the bottom for the last JSON line if the whole-buffer parse
  // fails (defensive — covers stray log lines before the envelope).
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let env = tryParse(stdout);
  if (Array.isArray(env)) env = env[env.length - 1];
  if (env && typeof env === 'object') return env;
  const lines = stdout.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParse(lines[i]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * Run the Robin Discord agent for one turn.
 *
 * @param {object} args
 * @param {string} args.prompt           The user's message (mention stripped)
 * @param {string|null} [args.sessionId] Prior agent session id to resume
 * @param {number} [args.maxTurns]
 * @param {number} [args.timeoutMs]
 * @param {AbortSignal} [args.signal]    Aborts the agent (SIGTERM → SIGKILL)
 * @param {string} [args.cwd]            Override agent cwd (tests)
 * @param {Function} [args.spawnFn]      Override child_process.spawn (tests)
 * @param {Function} [args.log]          Logger
 *
 * @returns {Promise<{ text: string, sessionId: string|null, isError: boolean,
 *                    subtype: string|null, costUsd: number, code: 'OK'|'TIMEOUT'|'CANCELLED'|'NONZERO_EXIT'|'PARSE_FAILED' }>}
 */
export function runDiscordAgent({
  prompt,
  sessionId = null,
  maxTurns = DEFAULT_MAX_TURNS,
  timeoutMs = envTimeoutMs(),
  signal,
  cwd = PKG_ROOT,
  spawnFn = nodeSpawn,
  log = () => {},
}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        text: '',
        sessionId: null,
        isError: false,
        subtype: null,
        costUsd: 0,
        code: 'CANCELLED',
      });
      return;
    }

    const args = buildArgs({ prompt, sessionId, maxTurns });
    let child;
    try {
      child = spawnFn('claude', args, {
        cwd,
        env: { ...process.env, ROBIN_SESSION_PLATFORM: 'discord' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      resolve({
        text: `(robin: failed to spawn agent: ${e.message})`,
        sessionId: null,
        isError: true,
        subtype: 'spawn_error',
        costUsd: 0,
        code: 'NONZERO_EXIT',
      });
      return;
    }

    let stdout = '';
    let stderrTail = '';
    const STDERR_CAP = 8 * 1024;
    let cancelled = false;
    let timedOut = false;

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      stderrTail += d.toString('utf-8');
      if (stderrTail.length > STDERR_CAP) stderrTail = stderrTail.slice(-STDERR_CAP);
    });

    const onAbort = () => {
      cancelled = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), SIGKILL_DELAY_MS);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), SIGKILL_DELAY_MS);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        text: `(robin: agent spawn error: ${e.message})`,
        sessionId: null,
        isError: true,
        subtype: 'spawn_error',
        costUsd: 0,
        code: 'NONZERO_EXIT',
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);

      if (cancelled) {
        resolve({
          text: '',
          sessionId: null,
          isError: false,
          subtype: null,
          costUsd: 0,
          code: 'CANCELLED',
        });
        return;
      }
      if (timedOut) {
        log(`agent timed out after ${timeoutMs}ms — stderr tail: ${stderrTail.slice(-512)}`);
        resolve({
          text: '(robin: agent timed out)',
          sessionId: null,
          isError: true,
          subtype: 'timeout',
          costUsd: 0,
          code: 'TIMEOUT',
        });
        return;
      }
      if (exitCode !== 0) {
        log(`agent exited ${exitCode} — stderr tail: ${stderrTail.slice(-512)}`);
        resolve({
          text: `(robin: agent exited ${exitCode})`,
          sessionId: null,
          isError: true,
          subtype: 'nonzero_exit',
          costUsd: 0,
          code: 'NONZERO_EXIT',
        });
        return;
      }

      const env = parseEnvelope(stdout);
      if (!env) {
        log(`agent stdout was not parseable JSON — head: ${stdout.slice(0, 512)}`);
        resolve({
          text: '(robin: agent produced unparseable output)',
          sessionId: null,
          isError: true,
          subtype: 'parse_failed',
          costUsd: 0,
          code: 'PARSE_FAILED',
        });
        return;
      }
      resolve({
        text: String(env.result ?? env.content ?? '').trim(),
        sessionId: env.session_id ?? null,
        isError: env.is_error === true,
        subtype: env.subtype ?? null,
        costUsd: env.total_cost_usd ?? 0,
        code: 'OK',
      });
    });
  });
}

export const __test__ = { PKG_ROOT, buildArgs, parseEnvelope, envTimeoutMs, FALLBACK_TIMEOUT_MS };

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * File-retention sweep for Robin's write-only artifact directories, which grew
 * without bound before this (2026-10: 1,942 agent-run transcripts / 287 MB, and
 * ~4 dated state/runtime files per day).
 *
 *  - `agent-runs/` — per-run JSONL transcripts + learning-record .md files.
 *    Nothing reads them back past the night they're written (the outcome lives
 *    in agent_usage), so every regular file older than the window by mtime goes.
 *  - `state/runtime/` — ONLY the date-stamped per-day markers/artifacts
 *    (`<name>-YYYY-MM-DD.json`: brief-delivered-, dream-synthesis-,
 *    dream-synthesis-staging-, reliability-audit-, nightly-critique-, …), aged by
 *    the date in the NAME, not mtime. Live state (boots.json, *.lock, daemon.pid,
 *    agent-runner-cursor, *-adaptive.json, note-session.json) never matches the
 *    pattern, and a defensive deny-list backs that up.
 */
export const RETENTION_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `<slug>-YYYY-MM-DD.json` — the dated-name shape, and nothing else. */
const DATED_RUNTIME_FILE = /^[a-z][a-z0-9-]*-(\d{4}-\d{2}-\d{2})\.json$/;

/** Belt-and-braces: live runtime state that must never be swept, whatever its name. */
const RUNTIME_DENY = /(?:^boots\.json$|\.lock$|\.pid$|cursor|adaptive)/;

export interface RetentionResult {
  agentRunsDeleted: number;
  agentRunsBytes: number;
  runtimeDeleted: number;
  errors: number;
}

export interface RetentionOptions {
  now?: Date;
  days?: number;
}

/** Delete regular files in `<userData>/agent-runs` whose mtime is older than the window. */
function sweepAgentRuns(dir: string, cutoffMs: number, res: RetentionResult): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
      unlinkSync(path);
      res.agentRunsDeleted += 1;
      res.agentRunsBytes += st.size;
    } catch {
      res.errors += 1;
    }
  }
}

/** Delete `<slug>-YYYY-MM-DD.json` files in `state/runtime` whose NAME date is older than the window. */
function sweepRuntime(dir: string, cutoffMs: number, res: RetentionResult): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const m = DATED_RUNTIME_FILE.exec(name);
    if (!m || RUNTIME_DENY.test(name)) continue;
    const dayMs = Date.parse(`${m[1]}T00:00:00Z`);
    // Compare the END of the named day so a file is kept for the full window.
    if (Number.isNaN(dayMs) || dayMs + DAY_MS >= cutoffMs) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      unlinkSync(path);
      res.runtimeDeleted += 1;
    } catch {
      res.errors += 1;
    }
  }
}

export function runRetention(userDataDir: string, opts: RetentionOptions = {}): RetentionResult {
  const now = (opts.now ?? new Date()).getTime();
  const cutoffMs = now - (opts.days ?? RETENTION_DAYS) * DAY_MS;
  const res: RetentionResult = {
    agentRunsDeleted: 0,
    agentRunsBytes: 0,
    runtimeDeleted: 0,
    errors: 0,
  };
  sweepAgentRuns(join(userDataDir, 'agent-runs'), cutoffMs, res);
  sweepRuntime(join(userDataDir, 'state', 'runtime'), cutoffMs, res);
  return res;
}

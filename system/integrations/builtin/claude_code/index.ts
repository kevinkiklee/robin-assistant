import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  captureSession,
  isInternalProjectDir,
  transcriptFileToCapture,
} from '../../../brain/cognition/capture.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';
import type { Integration, IntegrationContext, TickResult } from '../../_runtime/types.ts';

// Claude Code writes one .jsonl per session under ~/.claude/projects/<project-slug>/<sessionId>.jsonl.
// We scan that tree on a 5-minute cron, but capture each file only once it's been quiet — an in-flight
// session that's still being appended to would either (a) get captured early and miss its tail or
// (b) get re-captured repeatedly as a new dedup hash on each tick. SESSION_IDLE_MS is the wait.
// HOME is read at tick time, not module-load time, so tests can isolate to a tmpdir via process.env.HOME.
//
// State key is `session:<project-slug>:<sessionId>`. Namespacing by project guards against
// any collision if Claude Code ever reuses a session UUID across projects (unlikely, but the
// per-file mtime check is the only thing standing between us and a re-capture loop, so cheap to be safe).
const SESSION_IDLE_MS = 10 * 60 * 1000;
// A transcript untouched for longer than this is "historical" — it settled long ago and is
// not a newly-completed session. If we have NO dedup cursor for such a file (cold start, or
// the `session:*` state was purged), baseline it (record its mtime, do not capture) rather
// than ingesting it. This makes a missing cursor harmless: a full re-scan only ever ingests
// genuinely-recent activity, never the entire ~/.claude/projects history.
//
// Root cause this guards against (2026-06-13 re-burst): a maintenance purge wiped ~72.5k
// `session:*` state rows alongside the captured events, so on the next tick every settled
// transcript ever written looked new (lastCapturedMtime defaulted to 0) and ~3,674 historical
// sessions were re-ingested in a single hour — tripping the capture-volume invariant.
const SESSION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const STATE_KEY_PREFIX = 'session:';

// Cap on ACTUAL captures per tick. A daemon restart once drained a ~115-session backlog
// in a single tick, flooding the biographer and the memory graph. Once this many sessions
// have been captured this tick, defer the rest WITHOUT advancing their cursor so they're
// retried on the next 5-minute tick — a backlog then drains smoothly over several ticks.
// Only real captures count; the >48h baseline guard (which sets a cursor without capturing)
// is unaffected, so a wiped dedup state can't be throttled into a stall.
const MAX_CAPTURES_PER_TICK = 20;

function projectsDir(): string {
  return join(process.env.HOME ?? homedir(), '.claude', 'projects');
}

export const integration: Integration = {
  async health(_ctx: IntegrationContext) {
    if (!existsSync(projectsDir())) {
      return { ok: false, message: `${projectsDir()} does not exist` };
    }
    return { ok: true, message: 'reads Claude Code session transcripts' };
  },

  async tick(ctx: IntegrationContext): Promise<TickResult> {
    if (!existsSync(projectsDir())) {
      return { status: 'skipped', message: 'projects dir not found' };
    }

    const now = ctx.now().getTime();
    let captured = 0;
    let skipped = 0;
    let errored = 0;
    let deferred = 0;

    // Robin's own non-interactive Agent-SDK cognition calls (llm.invoke → claude-agent
    // → runSdk) write their transcripts under user-data/. Skip those project dirs
    // entirely so the scanner never re-captures Robin's own cognition I/O — the
    // self-amplifying loop that flooded capture on 2026-06-12/13. Resolve once per
    // tick; if it can't resolve, fall back to no-skip (the capture-time echo rules
    // still catch the content).
    let internalUserData: string | null = null;
    try {
      internalUserData = resolveUserDataDir();
    } catch {
      internalUserData = null;
    }

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(projectsDir()).filter((d) => !d.startsWith('.'));
    } catch (err) {
      return {
        status: 'error',
        message: `readdir ${projectsDir()} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    for (const projectDir of projectDirs) {
      if (internalUserData && isInternalProjectDir(projectDir, internalUserData)) continue;
      const fullProjectPath = join(projectsDir(), projectDir);
      let projectStat: ReturnType<typeof statSync>;
      try {
        projectStat = statSync(fullProjectPath);
      } catch {
        continue;
      }
      if (!projectStat.isDirectory()) continue;

      let sessionFiles: string[];
      try {
        sessionFiles = readdirSync(fullProjectPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const sessionFile of sessionFiles) {
        const sessionPath = join(fullProjectPath, sessionFile);
        let sessionStat: ReturnType<typeof statSync>;
        try {
          sessionStat = statSync(sessionPath);
        } catch {
          continue;
        }

        const mtimeMs = sessionStat.mtimeMs;
        const idleMs = now - mtimeMs;
        const sessionId = sessionFile.replace(/\.jsonl$/, '');
        const stateKey = `${STATE_KEY_PREFIX}${projectDir}:${sessionId}`;
        const lastCapturedMtime = Number(ctx.state.get(stateKey) ?? 0);

        // Already processed this session at this exact mtime — skip without parsing.
        if (mtimeMs <= lastCapturedMtime) continue;

        // Session still being appended to. Wait for it to settle so the capture is whole.
        if (idleMs < SESSION_IDLE_MS) {
          skipped++;
          continue;
        }

        // Historical transcript we have no cursor for (cold start / purged dedup state):
        // baseline it instead of ingesting. If it wasn't captured when it was fresh, it is
        // not "new" now — and this prevents a wiped `session:*` state from re-ingesting the
        // entire transcript history in one tick. A resumed session re-touches its file, so
        // idleMs drops below this horizon and it captures normally.
        if (idleMs > SESSION_MAX_AGE_MS && lastCapturedMtime === 0) {
          ctx.state.set(stateKey, String(mtimeMs));
          skipped++;
          continue;
        }

        // Per-tick capture cap. This session is eligible for an ACTUAL capture, but we've
        // already hit the cap this tick — defer it WITHOUT advancing its cursor so it's
        // reconsidered (and captured) on a subsequent tick. Drains a backlog gradually.
        if (captured >= MAX_CAPTURES_PER_TICK) {
          deferred++;
          continue;
        }

        try {
          const capture = transcriptFileToCapture(sessionId, sessionPath);
          if (capture.turns.length === 0) {
            skipped++;
            ctx.state.set(stateKey, String(mtimeMs));
            continue;
          }
          const result = await captureSession(ctx.db, ctx.llm, capture);
          if (result.captured) {
            captured++;
            ctx.log.info(
              { sessionId, turns: capture.turns.length, eventId: result.eventId },
              'claude-code session captured',
            );
          } else {
            skipped++;
            ctx.log.info({ sessionId, reason: result.skipReason }, 'claude-code session skipped');
          }
          // Mark mtime processed whether captured or skipped — only re-parse if the file changes again.
          ctx.state.set(stateKey, String(mtimeMs));
        } catch (err) {
          errored++;
          ctx.log.error({ err, sessionId }, 'claude-code session capture error');
        }
      }
    }

    if (deferred > 0) {
      ctx.log.info(
        { deferred, cap: MAX_CAPTURES_PER_TICK },
        'claude-code captures deferred to next tick (per-tick cap reached)',
      );
    }

    return {
      status: errored > 0 && captured === 0 ? 'error' : 'ok',
      ingested: captured,
      message: `captured=${captured} skipped=${skipped} errored=${errored}`,
    };
  },
};

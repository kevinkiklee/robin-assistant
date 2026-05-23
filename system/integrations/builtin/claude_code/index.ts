import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureSession, transcriptFileToCapture } from '../../../brain/cognition/capture.ts';
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
const STATE_KEY_PREFIX = 'session:';

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

    return {
      status: errored > 0 && captured === 0 ? 'error' : 'ok',
      ingested: captured,
      message: `captured=${captured} skipped=${skipped} errored=${errored}`,
    };
  },
};

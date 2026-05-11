import { endSession, listActiveSessions, markStaleSessions, registerSession } from '../sessions.js';

export const sessionRoutes = [
  {
    method: 'POST',
    path: '/internal/session/register',
    async handler({ ctx, body }) {
      await markStaleSessions(ctx.db).catch(() => {});
      await registerSession(ctx.db, {
        sessionId: body.session_id ?? body.sessionId ?? `pid-${body.pid ?? 'unknown'}`,
        host: body.host ?? 'unknown',
        pid: typeof body.pid === 'number' ? body.pid : null,
        transcriptPath: body.transcript_path ?? body.transcriptPath ?? null,
      });
      const active = await listActiveSessions(ctx.db);
      let introspection_findings = [];
      try {
        const [rows] = await ctx.db
          .query("SELECT * FROM type::record('runtime_introspection_state', 'current')")
          .collect();
        introspection_findings = rows?.[0]?.findings ?? [];
      } catch {
        introspection_findings = [];
      }
      return { session_count: active.length, introspection_findings };
    },
  },
  {
    method: 'POST',
    path: '/internal/session/end',
    async handler({ ctx, body }) {
      await endSession(ctx.db, body.session_id ?? body.sessionId ?? `pid-${body.pid ?? 'unknown'}`);
      return { ok: true };
    },
  },
];

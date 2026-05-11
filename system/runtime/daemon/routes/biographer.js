import { captureFromTranscript } from '../../../io/capture/session-capture.js';

export const biographerRoutes = [
  {
    method: 'POST',
    path: '/internal/biographer/process-pending',
    async handler({ ctx, body }) {
      // Capture pre-step (fail-soft). When the Stop hook forwards
      // transcript_path, read the latest turn and write a conversation
      // event before draining pending — biographer then processes it
      // alongside any other pending rows.
      if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
        try {
          await captureFromTranscript(ctx.db, ctx.embedder.wrap, {
            transcriptPath: body.transcript_path,
            sessionId: body.session_id ?? body.sessionId ?? null,
            host: ctx.host?.name ?? null,
          });
        } catch (e) {
          console.error(`daemon capture pre-step failed: ${e.message}`);
        }
      }
      const [pendingRows] = await ctx.db
        .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
        .collect();
      for (const row of pendingRows) {
        ctx.queue.enqueue(String(row.id)).catch(() => {
          // queueWrap already logs.
        });
      }
      return { enqueued: pendingRows.length };
    },
  },
];

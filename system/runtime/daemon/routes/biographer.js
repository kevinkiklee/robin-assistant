import { listPendingEvents } from '../../../cognition/biographer/pending-events.js';
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
      // C1: Refresh batch_config snapshot before draining so operator changes
      // to runtime:biographer.value.batch_config take effect at flush time.
      if (ctx.accumulator?.refreshConfig) {
        await ctx.accumulator.refreshConfig();
      }
      const pendingRows = await listPendingEvents(ctx.db, { limit: 50 });
      for (const row of pendingRows) {
        try {
          if (ctx.accumulator?.add) {
            ctx.accumulator.add(String(row.id), String(row.source ?? 'cli'));
          } else {
            // Defensive: pre-C1 single-id path if the accumulator is somehow
            // unwired (should not happen in production boots).
            ctx.queue.enqueue(String(row.id)).catch(() => {});
          }
        } catch (e) {
          console.warn(`[biographer] accumulator.add failed for ${row.id}: ${e.message}`);
        }
      }
      return { enqueued: pendingRows.length };
    },
  },
];

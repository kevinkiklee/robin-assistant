import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';
import { recordEvent } from '../../../io/capture/record-event.js';

export const rememberRoutes = [
  {
    method: 'POST',
    path: '/internal/remember',
    schema: { content: 'string', source: 'string?', meta: 'object?', force: 'boolean?' },
    async handler({ ctx, body }) {
      // content non-empty is the only check left; type+presence done by schema.
      if (body.content.length === 0) {
        return { _status: 400, _body: { ok: false, error: 'content required' } };
      }
      try {
        const result = await recordEvent(ctx.db, ctx.embedder.wrap, {
          source: body.source ?? 'cli',
          content: body.content,
          meta: body.meta ?? undefined,
          guard: body.force === true ? undefined : guardInboundContent,
        });
        try {
          if (ctx.accumulator?.add) {
            ctx.accumulator.add(String(result.id), String(body.source ?? 'cli'));
          } else {
            // Defensive: pre-C1 single-id path if the accumulator is unwired.
            ctx.queue.enqueue(String(result.id)).catch(() => {});
          }
        } catch (e) {
          console.warn(`[biographer] accumulator.add failed for ${result.id}: ${e.message}`);
        }
        return { id: String(result.id) };
      } catch (e) {
        const code = e?.name === 'RobinPiiRefusedError' ? 422 : 500;
        return { _status: code, _body: { error: e.message, name: e?.name } };
      }
    },
  },
];

import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';
import { recordEvent } from '../../../io/capture/record-event.js';

export const rememberRoutes = [
  {
    method: 'POST',
    path: '/internal/remember',
    async handler({ ctx, body }) {
      if (typeof body.content !== 'string' || body.content.length === 0) {
        return { _status: 400, _body: { error: 'content required' } };
      }
      try {
        const result = await recordEvent(ctx.db, ctx.embedder.wrap, {
          source: body.source ?? 'cli',
          content: body.content,
          meta: body.meta ?? undefined,
          guard: body.force === true ? undefined : guardInboundContent,
        });
        ctx.queue.enqueue(String(result.id)).catch(() => {
          // queueWrap already logs.
        });
        return { id: String(result.id) };
      } catch (e) {
        const code = e?.name === 'RobinPiiRefusedError' ? 422 : 500;
        return { _status: code, _body: { error: e.message, name: e?.name } };
      }
    },
  },
];

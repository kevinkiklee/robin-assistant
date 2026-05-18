import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';
import { getSessionTaint } from '../../../runtime/mcp/session-taint.js';
import { recordEvent } from '../../capture/record-event.js';

export function createRememberTool({ db, embedder, queue, getSessionId }) {
  return {
    name: 'remember',
    description:
      "Save a noteworthy observation to the user's memory. Be discerning — explicit preferences, named projects/people, decisions, deadlines are good candidates.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10000 },
        source: { type: 'string', default: 'manual' },
        meta: { type: 'object' },
        trigger_biographer: { type: 'boolean', default: true },
        source_trust: { type: 'string', enum: ['trusted', 'untrusted'] },
      },
      required: ['content'],
    },
    handler: async (args) => {
      const sessionId = getSessionId?.() ?? null;
      const taint = getSessionTaint(sessionId);
      const trust = args.source_trust ?? (taint.tainted ? 'untrusted' : 'trusted');
      const result = await recordEvent(db, embedder, {
        source: args.source ?? 'manual',
        content: args.content,
        meta: args.meta,
        trust,
        guard: guardInboundContent,
      });
      if (args.trigger_biographer !== false) {
        queue
          .enqueue(String(result.id))
          .catch((e) =>
            console.warn(`[remember] biographer enqueue failed for ${result.id}: ${e.message}`),
          );
      }
      return { id: String(result.id) };
    },
  };
}

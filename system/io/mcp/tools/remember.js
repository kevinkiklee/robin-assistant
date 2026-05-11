import { recordEvent } from '../../capture/record-event.js';
import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';

export function createRememberTool({ db, embedder, queue }) {
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
      },
      required: ['content'],
    },
    handler: async (args) => {
      const result = await recordEvent(db, embedder, {
        source: args.source ?? 'manual',
        content: args.content,
        meta: args.meta,
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

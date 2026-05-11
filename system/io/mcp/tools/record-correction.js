import { recordEvent } from '../../capture/record-event.js';
import { guardInboundContent } from '../../../cognition/discretion/inbound-guard.js';

export function createRecordCorrectionTool({ db, embedder, processor }) {
  return {
    name: 'record_correction',
    description:
      "When the user corrects you — 'no, that's wrong', 'I prefer X' — call this. Robin learns from these corrections to avoid repeating mistakes.",
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10000 },
        prior_response: { type: 'string' },
        meta: { type: 'object' },
        tool: { type: 'string' },
        action: { type: 'string' },
      },
      required: ['content'],
    },
    handler: async (args) => {
      const meta = {
        kind: 'correction',
        ...(args.prior_response ? { prior_response: args.prior_response } : {}),
        ...(args.meta ?? {}),
      };
      const result = await recordEvent(db, embedder, {
        source: 'manual',
        content: args.content,
        meta,
        guard: guardInboundContent,
      });
      try {
        await processor(result.id);
      } catch (e) {
        console.error(`record_correction biographer failed: ${e.message}`);
      }
      let demoted_class = null;
      if (args.tool && args.action) {
        const cls = `${args.tool}:${args.action}`;
        const { demoteOnCorrection } = await import('../../../cognition/jobs/action-trust.js');
        const r = await demoteOnCorrection(db, cls);
        if (r.demoted) demoted_class = cls;
      }
      return { id: String(result.id), demoted_class };
    },
  };
}

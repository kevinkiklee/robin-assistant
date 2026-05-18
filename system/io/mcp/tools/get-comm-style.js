// src/mcp/tools/get-comm-style.js

import { resolveSessionContext } from '../../../cognition/dream/comm-style-context-router.js';
import { getEffectiveContextCommStyle } from '../../../cognition/dream/step-comm-style.js';
import { DEFAULTS, getCommStyle } from '../../../cognition/jobs/comm-style.js';

export function createGetCommStyleTool({ db }) {
  return {
    name: 'get_comm_style',
    description:
      "Read the user's inferred communication-style preferences. Returns balanced defaults with confidence: 0 if never synthesized. Pass an optional 'context' ('discord'|'terminal'|'web') to get the per-context style; falls back to the default if no per-context record exists.",
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          enum: ['discord', 'terminal', 'web'],
          description:
            "Optional. Comm-style context to retrieve. Defaults to the session's ROBIN_SESSION_PLATFORM. Falls back to the flat default when no per-context record has been synthesized.",
        },
      },
    },
    handler: async ({ context } = {}) => {
      // Resolve context: explicit arg → env-based auto-detect.
      const ctx =
        context && ['discord', 'terminal', 'web'].includes(context)
          ? context
          : resolveSessionContext();

      // Try per-context row first; fall back to flat default.
      const perCtxRow = await getEffectiveContextCommStyle(db, ctx);
      if (perCtxRow) {
        return { ...perCtxRow, synthesized: true, context: ctx };
      }

      const row = await getCommStyle(db);
      if (!row) {
        return {
          ...DEFAULTS,
          evidence: [],
          confidence: 0,
          last_synthesized_at: null,
          synthesized: false,
        };
      }
      return { ...row, synthesized: true };
    },
  };
}

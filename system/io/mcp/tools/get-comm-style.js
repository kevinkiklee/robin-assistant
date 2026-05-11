// src/mcp/tools/get-comm-style.js
import { DEFAULTS, getCommStyle } from '../../../cognition/jobs/comm-style.js';

export function createGetCommStyleTool({ db }) {
  return {
    name: 'get_comm_style',
    description:
      "Read the user's inferred communication-style preferences. Returns balanced defaults with confidence: 0 if never synthesized.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
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

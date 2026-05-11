import { runLintChecks } from '../../jobs/lint-checks.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export function createLintTool({ db }) {
  return {
    name: 'lint',
    description:
      'Mechanical health check of memory: orphans, dead edges, duplicates, near-dupes, stale knowledge. Read-only. User-triggered.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    },
    handler: async (input = {}) => {
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
      const issues = await runLintChecks(db);
      return {
        ok: true,
        issues: issues.slice(0, limit),
        total: issues.length,
        returned: Math.min(issues.length, limit),
      };
    },
  };
}

import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createGetPlaybookTool({ db }) {
  return {
    name: 'get_playbook',
    description:
      'Fetch a single playbook by ID, including its full step-by-step content, task_type, status, and the outcome IDs that sourced it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const { id } = args;

      // Normalize the ID to a SurrealDB record reference string
      const recordRef = id.startsWith('memos:') ? id : `memos:${id}`;

      const [rows] = await db.query(`SELECT * FROM ${recordRef} WHERE kind = 'playbook'`).collect();

      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }

      return {
        ok: true,
        playbook: {
          id: String(row.id),
          kind: row.kind,
          content: row.content,
          content_hash: row.content_hash ?? null,
          confidence: row.confidence ?? null,
          signal_count: row.signal_count ?? null,
          derived_by: row.derived_by,
          derived_at: row.derived_at,
          updated_at: row.updated_at,
          scope: row.scope,
          tags: row.tags ?? [],
          meta: row.meta ?? {},
        },
      };
    },
  };
}

import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createListPlaybooksTool({ db }) {
  return {
    name: 'list_playbooks',
    description:
      "List Robin's learned playbooks — synthesized step-by-step guides for recurring task types. Filter by task_type or list all active playbooks.",
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        active_only: { type: 'boolean', default: true },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const activeOnly = args.active_only !== false;
      const taskType = args.task_type ?? null;

      const filters = ["kind = 'playbook'"];
      const bindings = {};

      if (activeOnly) {
        filters.push('meta.active = true');
      }
      if (taskType) {
        filters.push('meta.task_type = $task_type');
        bindings.task_type = taskType;
      }

      // SurrealDB v3 requires ORDER BY fields to appear in the SELECT list.
      // Select the sort key explicitly as `last_synthesized_at` to avoid parse error.
      const sql = `
        SELECT id, meta, meta.last_synthesized_at AS last_synthesized_at
        FROM memos
        WHERE ${filters.join(' AND ')}
        ORDER BY last_synthesized_at DESC
      `;

      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];

      const playbooks = list.map((r) => ({
        id: String(r.id),
        task_type: r.meta?.task_type ?? null,
        version: r.meta?.version ?? null,
        active: r.meta?.active ?? null,
        cold_start: r.meta?.cold_start ?? null,
        last_synthesized_at: r.meta?.last_synthesized_at ?? null,
      }));

      return { ok: true, playbooks };
    },
  };
}

import { BoundQuery } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function createListCommStyleSnapshotsTool({ db }) {
  return {
    name: 'list_comm_style_snapshots',
    description:
      'List historical comm_style_snapshot memos in reverse chronological order. Each snapshot records the synthesized communication-style preferences at a point in time, enabling trend inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };

      const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

      // SurrealDB v3 requires ORDER BY fields to appear in the SELECT list.
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT id, meta, meta.last_synthesized_at AS last_synthesized_at
             FROM memos
             WHERE kind = 'comm_style_snapshot'
             ORDER BY last_synthesized_at DESC
             LIMIT $limit`,
            { limit },
          ),
        )
        .collect();

      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];

      const snapshots = list.map((r) => ({
        id: String(r.id),
        context: r.meta?.context ?? null,
        content_hash: r.meta?.content_hash ?? null,
        last_synthesized_at: r.meta?.last_synthesized_at ?? null,
        volatile: r.meta?.volatile ?? false,
      }));

      // Note: per spec §4d gap, comm_style_snapshot memos are not yet written by
      // the synthesis step (Wave 3-C follow-up). This returns whatever exists —
      // may be empty until that gap is resolved.
      return { ok: true, snapshots };
    },
  };
}

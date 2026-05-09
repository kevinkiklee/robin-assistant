import { surql } from 'surrealdb';

export function createMarkRecallUsedTool({ db }) {
  return {
    name: 'mark_recall_used',
    description:
      'After using results from `recall`, mark which hits informed your answer. Helps Robin learn to surface better results.',
    inputSchema: {
      type: 'object',
      properties: {
        recall_event_id: { type: 'string' },
        used_hit_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['recall_event_id', 'used_hit_ids'],
    },
    handler: async (args) => {
      const key = args.recall_event_id.startsWith('recall_events:')
        ? args.recall_event_id.slice('recall_events:'.length)
        : args.recall_event_id;
      const [rows] = await db
        .query(surql`SELECT hit_ids, hit_used FROM type::record('recall_events', ${key})`)
        .collect();
      if (!rows || rows.length === 0) {
        throw new Error(`recall_event not found: ${args.recall_event_id}`);
      }
      const { hit_ids, hit_used } = rows[0];
      const usedSet = new Set(args.used_hit_ids.map((s) => s));
      const newUsed = hit_ids.map((hid, i) => {
        if (hit_used[i]) return true;
        return usedSet.has(String(hid));
      });
      let updated = 0;
      for (let i = 0; i < hit_used.length; i++) {
        if (newUsed[i] && !hit_used[i]) updated++;
      }
      await db
        .query(surql`UPDATE type::record('recall_events', ${key}) SET hit_used = ${newUsed}`)
        .collect();
      return { updated };
    },
  };
}

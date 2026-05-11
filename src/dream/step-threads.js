import { surql } from 'surrealdb';
import { createThread } from '../memory/narrative.js';

const DEFAULT_RECENCY_DAYS = 7;

/**
 * Heuristic thread builder.
 *
 * Finds entities mentioned across 2+ episodes within the recency window
 * and creates one `threads` row per qualifying entity grouping.
 *
 * Implementation: gather candidate events first (recent + episode-bound),
 * then traverse `mentions` against that filtered set. The two-step form
 * avoids relying on `in.ts`/`in.episode_id` traversal inside `GROUP BY`,
 * which behaves inconsistently across SurrealDB engines.
 */
export async function dreamStepThreads(db, { recencyDays = DEFAULT_RECENCY_DAYS } = {}) {
  const cutoff = new Date(Date.now() - recencyDays * 86400_000);
  const [eventIds] = await db
    .query(
      surql`SELECT VALUE id FROM events
            WHERE ts >= ${cutoff} AND episode_id IS NOT NONE`,
    )
    .collect();
  if (!eventIds || eventIds.length === 0) return { created: 0 };

  const [groups] = await db
    .query(
      surql`SELECT out AS entity_id, array::distinct(in.episode_id) AS episodes
            FROM mentions
            WHERE in IN ${eventIds}
            GROUP BY entity_id`,
    )
    .collect();

  let created = 0;
  for (const g of groups ?? []) {
    const eps = (g.episodes ?? []).filter(Boolean);
    if (eps.length < 2) continue;
    await createThread(db, {
      title: null,
      episode_ids: eps,
      entity_ids: [g.entity_id],
    });
    created++;
  }
  return { created };
}

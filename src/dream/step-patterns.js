import { surql } from 'surrealdb';
import { upsertPatternByName } from '../memory/habits.js';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MIN_STRENGTH = 5;
const DEFAULT_LIMIT = 10;

/**
 * Heuristic pattern detection — no LLM in this version.
 *
 * Looks at `co_occurs_with` edges with `last_seen` within the lookback
 * window and `strength ≥ minStrength`, then upserts a `co-occur-A-B`
 * pattern row per qualifying pair. Idempotent via `upsertPatternByName`:
 * repeated runs increment `signal_count` instead of creating duplicates.
 */
export async function dreamStepPatterns(_db, _host) {
  const db = _db;
  const cutoff = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000);
  const [strong] = await db
    .query(
      surql`SELECT in, out, strength FROM co_occurs_with
            WHERE last_seen >= ${cutoff} AND strength >= ${DEFAULT_MIN_STRENGTH}
            LIMIT ${DEFAULT_LIMIT}`,
    )
    .collect();
  let upserted = 0;
  for (const edge of strong ?? []) {
    const [a] = await db.query(surql`SELECT name FROM ${edge.in}`).collect();
    const [b] = await db.query(surql`SELECT name FROM ${edge.out}`).collect();
    if (!a[0] || !b[0]) continue;
    await upsertPatternByName(db, {
      name: `co-occur-${a[0].name}-${b[0].name}`,
      description: `${a[0].name} and ${b[0].name} co-occur frequently (strength ${edge.strength})`,
      source_events: [],
    });
    upserted++;
  }
  return { upserted };
}

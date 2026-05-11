// step-patterns.js — habit discovery from edges[kind='occurs_with'].
//
// Writes memos[kind='habit'] via habits.upsert. Co-occurrence pairs whose
// `weight >= minStrength` within `lookbackDays` become habits named
// `co-occur-<a>-<b>`.

import { BoundQuery } from 'surrealdb';
import { upsert as habitsUpsert } from '../memory/habits.js';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MIN_STRENGTH = 5;
const DEFAULT_LIMIT = 10;

export async function dreamStepPatterns(db, host, opts = {}) {
  const {
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    minStrength = DEFAULT_MIN_STRENGTH,
    limit = DEFAULT_LIMIT,
    embedder = null,
  } = opts;
  void host;

  const cutoff = new Date(Date.now() - lookbackDays * 86400_000);
  const sql = `
    SELECT from, to, weight
    FROM edges
    WHERE kind = 'occurs_with' AND last_seen >= $cutoff AND weight >= $min
    ORDER BY weight DESC
    LIMIT ${limit}
  `;
  const [strong] = await db.query(new BoundQuery(sql, { cutoff, min: minStrength })).collect();

  let upserted = 0;
  for (const edge of strong ?? []) {
    const [a] = await db.query(new BoundQuery('SELECT name FROM $id', { id: edge.from })).collect();
    const [b] = await db.query(new BoundQuery('SELECT name FROM $id', { id: edge.to })).collect();
    if (!a[0]?.name || !b[0]?.name) continue;

    const name = `co-occur-${a[0].name}-${b[0].name}`;
    const description = `${a[0].name} and ${b[0].name} co-occur frequently (weight=${edge.weight}).`;
    if (embedder) {
      await habitsUpsert(db, embedder, {
        name,
        description,
        lineage: [],
        strength: Number(edge.weight) || 1.0,
      });
      upserted += 1;
    }
  }
  return { upserted };
}

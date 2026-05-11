// cursors.js — per-step "since" cursors used by cursor-aware nightly + trigger consumer.
// Theme 3.

import { BoundQuery } from 'surrealdb';

export async function getCursor(db, step) {
  try {
    const [rows] = await db
      .query(new BoundQuery('SELECT VALUE value FROM runtime:`cadence.cursors`', {}))
      .collect();
    const v = rows?.[0]?.[step];
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

export async function advanceCursor(db, step, ts) {
  const iso = ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
  // Read current cursors, merge, write back. Simpler than nested-key UPDATE.
  const [rows] = await db
    .query(new BoundQuery('SELECT VALUE value FROM runtime:`cadence.cursors`', {}))
    .collect();
  const current = rows?.[0] ?? {};
  current[step] = iso;
  await db
    .query(new BoundQuery('UPDATE runtime:`cadence.cursors` SET value = $v', { v: current }))
    .collect();
}

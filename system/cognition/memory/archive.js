// archive.js — the only writer to archive_memos/archive_edges/archive_log.
// Theme 1a. Per-memo archive transaction copies row + incident edges out of
// hot tables, then deletes from hot.

import { BoundQuery } from 'surrealdb';

const HOT_FIELDS = [
  'kind',
  'content',
  'content_hash',
  'confidence',
  'signal_count',
  'decay_anchor',
  'derived_by',
  'derived_at',
  'updated_at',
  'last_active',
  'scope',
  'tags',
  'meta',
];

function pickFields(row) {
  const out = {};
  for (const f of HOT_FIELDS) {
    if (row[f] !== undefined && row[f] !== null) out[f] = row[f];
  }
  return out;
}

export async function archiveMemo(db, id, reason) {
  // Read the row + incident edges first; do the writes one statement at a time
  // (SurrealDB v3 transactions roll back on any error within them).
  const [memoRows] = await db.query(new BoundQuery('SELECT * FROM ONLY $id', { id })).collect();
  const memo = memoRows?.[0] ?? memoRows;
  if (!memo?.id) return { archived: null };

  const [edgesIn] = await db
    .query(new BoundQuery('SELECT * FROM edges WHERE in = $id OR out = $id', { id }))
    .collect();
  const incidentEdges = edgesIn ?? [];

  // Insert archive_memos row
  const archiveContent = { ...pickFields(memo), archive_reason: reason };
  const [archived] = await db
    .query(new BoundQuery('CREATE archive_memos CONTENT $row', { row: archiveContent }))
    .collect();
  const archivedId = archived?.[0]?.id ?? archived?.id;

  // Copy incident edges
  for (const e of incidentEdges) {
    const edgeFields = {};
    for (const k of ['kind', 'in', 'out', 'weight', 'last_seen', 'context', 'meta']) {
      if (e[k] !== undefined && e[k] !== null) edgeFields[k] = e[k];
    }
    try {
      await db
        .query(new BoundQuery('CREATE archive_edges CONTENT $row', { row: edgeFields }))
        .collect();
    } catch (err) {
      console.warn(`[archive] edge copy failed: ${err.message}`);
    }
  }

  // Delete hot rows
  await db.query(new BoundQuery('DELETE edges WHERE in = $id OR out = $id', { id })).collect();
  await db.query(new BoundQuery('DELETE $id', { id })).collect();

  // Log
  await db
    .query(
      new BoundQuery(
        `CREATE archive_log CONTENT { memo_id: $aid, action: 'archived', reason: $reason }`,
        { aid: archivedId, reason },
      ),
    )
    .collect();

  return { archived: archivedId };
}

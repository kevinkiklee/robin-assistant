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

export async function restoreMemo(db, archivedId) {
  const [rows] = await db
    .query(new BoundQuery('SELECT * FROM ONLY $id', { id: archivedId }))
    .collect();
  const arch = rows?.[0] ?? rows;
  if (!arch?.id) return { restored: null };

  const [edgesIn] = await db
    .query(
      new BoundQuery('SELECT * FROM archive_edges WHERE in = $id OR out = $id', { id: archivedId }),
    )
    .collect();
  const incident = edgesIn ?? [];

  const memoContent = pickFields(arch);
  const [created] = await db
    .query(new BoundQuery('CREATE memos CONTENT $row', { row: memoContent }))
    .collect();
  const newId = created?.[0]?.id ?? created?.id;

  for (const e of incident) {
    const edgeFields = {};
    for (const k of ['kind', 'in', 'out', 'weight', 'last_seen', 'context', 'meta']) {
      if (e[k] !== undefined && e[k] !== null) edgeFields[k] = e[k];
    }
    try {
      await db
        .query(
          new BoundQuery(
            `INSERT RELATION INTO edges {
              id: [$kind, $in, $out],
              kind: $kind, in: $in, out: $out
            } ON DUPLICATE KEY UPDATE last_seen = time::now()`,
            { kind: edgeFields.kind, in: edgeFields.in, out: edgeFields.out },
          ),
        )
        .collect();
    } catch (err) {
      console.warn(`[restore] edge restore failed: ${err.message}`);
    }
  }

  await db
    .query(new BoundQuery('DELETE archive_edges WHERE in = $id OR out = $id', { id: archivedId }))
    .collect();
  await db.query(new BoundQuery('DELETE $id', { id: archivedId })).collect();
  await db
    .query(
      new BoundQuery(
        `CREATE archive_log CONTENT { memo_id: $nid, action: 'restored', reason: 'restored_by_user' }`,
        { nid: newId },
      ),
    )
    .collect();

  return { restored: newId };
}

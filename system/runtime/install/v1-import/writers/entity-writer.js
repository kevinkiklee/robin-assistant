// entity-writer.js — UPSERT entities with deterministic record ID + alias merge.
//
// Deterministic ID `entities:<type>__<name_lower>` matches the convention used
// by `cognition/biographer/upsert-entity.js`, so re-imports + concurrent writes
// converge to the same row.

import { BoundQuery } from 'surrealdb';
import { entityRecordKey } from '../../../../cognition/biographer/upsert-entity.js';
import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { upsertWithLedger } from '../tx.js';

function canonicalPayload({ name, type, aliases }) {
  return JSON.stringify({ name, type, aliases: [...aliases].sort() });
}

function uniqOrdered(arr) {
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Upsert an entity by (type, name). On hit, merge `meta.aliases` (union, dedup).
 * Writes one _v1_imports row.
 *
 * @returns {Promise<{ id: object | string | null, action: 'created'|'merged'|'skipped', hash: string }>}
 */
export async function upsertEntity(db, { name, type, aliases = [], sourcePath, sessionId }) {
  if (!name) throw new TypeError('upsertEntity: name required');
  if (!type) throw new TypeError('upsertEntity: type required');

  const dedupedAliases = uniqOrdered(aliases.filter((a) => a && a !== name));
  const hash = sha256(
    `${sourcePath}\n${canonicalPayload({ name, type, aliases: dedupedAliases })}`,
  );

  const key = entityRecordKey(type, name);
  const recordIdStr = `entities:${key}`;

  if (await hashExists(db, hash)) {
    // Idempotent re-run: this exact entity payload is already in the
    // ledger. Look up the existing record id so callers (Pass A's
    // entitiesByPath, Pass B's about-edge writer) get a usable ref. The
    // earlier `{ id: null, action: 'skipped' }` was the cause of the
    // "upsertEdge: to: missing or invalid record ref" cascade on re-imports.
    // type::record needs (table, id) parts — passing a single "table:id"
    // string is rejected by SurrealDB.
    const [existing] = await db
      .query(new BoundQuery('SELECT id FROM type::record($tb, $k)', { tb: 'entities', k: key }))
      .collect();
    const existingId = Array.isArray(existing) && existing.length > 0 ? existing[0].id : null;
    return { id: existingId, action: 'skipped', hash };
  }

  // Look up existing row first (read-only; outside the transaction).
  const [existing] = await db
    .query(new BoundQuery('SELECT id, meta FROM type::record($r)', { r: recordIdStr }))
    .collect();
  let action = 'created';
  let aliasesFinal = dedupedAliases;
  if (Array.isArray(existing) && existing.length > 0) {
    action = 'merged';
    const priorAliases = Array.isArray(existing[0]?.meta?.aliases) ? existing[0].meta.aliases : [];
    aliasesFinal = uniqOrdered([...priorAliases, ...dedupedAliases]);
  }

  const fields = {
    name,
    type,
    scope: 'global',
    tags: [],
    meta: { aliases: aliasesFinal, imported_from: 'v1', v1_source_path: sourcePath },
  };
  const { id } = await upsertWithLedger(db, {
    recordIdStr,
    fields,
    sourcePath,
    contentHash: hash,
    ledgerKind: 'entity',
    sessionId,
  });
  return { id, action, hash };
}

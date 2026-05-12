// tx.js — atomic `CREATE row + CREATE _v1_imports` transactions.
//
// SurrealDB requires transactions to live inside a single multi-statement
// query: BEGIN/COMMIT in separate `db.query(...)` calls fail with "Cannot
// COMMIT without starting a transaction". We sidestep extracting the
// created row's auto-id by generating the record id JS-side (via
// `randomUUID`), so both statements in the transaction reference the same
// deterministic id without round-tripping.

import { randomUUID } from 'node:crypto';
import { BoundQuery, RecordId } from 'surrealdb';

/**
 * Atomically CREATE one row + one _v1_imports ledger row.
 *
 * @returns {Promise<{ id: RecordId, idStr: string }>}
 */
export async function createWithLedger(db, args) {
  const { table, fields, sourcePath, contentHash, ledgerKind, sessionId } = args;
  const key = randomUUID().replace(/-/g, '');
  const idStr = `${table}:${key}`;
  const sql = `
    BEGIN TRANSACTION;
    CREATE type::record($tb, $idKey) CONTENT $fields;
    CREATE _v1_imports SET
      source_path    = $sp,
      content_hash   = $h,
      target         = $target,
      kind           = $k,
      import_session = $s;
    COMMIT TRANSACTION;
  `;
  await db
    .query(
      new BoundQuery(sql, {
        tb: table,
        idKey: key,
        fields,
        sp: sourcePath,
        h: contentHash,
        target: idStr,
        k: ledgerKind,
        s: sessionId,
      }),
    )
    .collect();
  return { id: new RecordId(table, key), idStr };
}

/**
 * Atomically UPSERT a specific record id + one _v1_imports ledger row.
 * Used for entities (deterministic (type, name) key) and persona singleton.
 *
 * @returns {Promise<{ id: RecordId, idStr: string }>}
 */
export async function upsertWithLedger(db, args) {
  const {
    recordIdStr,
    fields,
    sourcePath,
    contentHash,
    ledgerKind,
    sessionId,
    mergeNotContent = false,
  } = args;
  const op = mergeNotContent ? 'MERGE' : 'CONTENT';
  const [table, key] = splitRecordIdStr(recordIdStr);

  const sql = `
    BEGIN TRANSACTION;
    UPSERT type::record($tb, $idKey) ${op} $fields;
    CREATE _v1_imports SET
      source_path    = $sp,
      content_hash   = $h,
      target         = $target,
      kind           = $k,
      import_session = $s;
    COMMIT TRANSACTION;
  `;
  await db
    .query(
      new BoundQuery(sql, {
        tb: table,
        idKey: key,
        fields,
        sp: sourcePath,
        h: contentHash,
        target: recordIdStr,
        k: ledgerKind,
        s: sessionId,
      }),
    )
    .collect();
  return { id: new RecordId(table, key), idStr: recordIdStr };
}

function splitRecordIdStr(s) {
  const i = s.indexOf(':');
  if (i < 1) throw new TypeError(`invalid record id string: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
}

// event-writer.js — CREATE event with biographed_at=NULL + ledger row.
//
// Imported events deliberately leave `biographed_at` and `dreamed_at` unset
// so the live heartbeat picks them up on its normal schedule.

import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { createWithLedger } from '../tx.js';

export async function createEvent(db, input) {
  const { source, content, ts, meta: callerMeta = {}, sourcePath, sessionId } = input;
  if (!source) throw new TypeError('createEvent: source required');
  if (!content) throw new TypeError('createEvent: content required');
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) {
    throw new TypeError('createEvent: ts must be a valid Date');
  }

  const meta = {
    ...callerMeta,
    imported_from: 'v1',
    v1_source_path: sourcePath,
  };
  const hashSeed = JSON.stringify({ source, content, ts: ts.toISOString(), meta });
  const hash = sha256(`${sourcePath}\n${hashSeed}`);
  if (await hashExists(db, hash)) {
    return { id: null, action: 'skipped', hash };
  }

  const fields = {
    source,
    content,
    content_hash: sha256(content),
    // SurrealDB's JS SDK serializes JS Date to datetime; pass the Date directly
    // (not toISOString — that becomes a string and fails the datetime coercion).
    ts,
    trust: 'trusted',
    scope: 'global',
    tags: [],
    attachments: [],
    meta,
  };
  const { id } = await createWithLedger(db, {
    table: 'events',
    fields,
    sourcePath,
    contentHash: hash,
    ledgerKind: 'event',
    sessionId,
  });
  return { id, action: 'created', hash };
}

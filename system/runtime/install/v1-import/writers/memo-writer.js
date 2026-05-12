// memo-writer.js — CREATE memo + ledger row, atomically.
//
// Embedding is NOT done here. Pass G runs `embeddings-backfill.js` after all
// passes complete; it covers events + memos + entities in one batch.

import { RecordId } from 'surrealdb';
import { sha256 } from '../../../../data/embed/hash.js';
import { findByHash, hashExists } from '../ledger.js';
import { createWithLedger } from '../tx.js';

// Parse a stringified record id (e.g. "memos:abc123") back into the SDK's
// RecordId type so callers can hand it to upsertEdge etc. without
// reconstructing the parts.
function parseRecordIdStr(s) {
  if (!s || typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i < 1) return null;
  return new RecordId(s.slice(0, i), s.slice(i + 1));
}

function canonicalPayload({ kind, content, confidence, meta }) {
  return JSON.stringify({ kind, content, confidence, meta });
}

/**
 * Create a memos row + ledger row in one transaction.
 *
 * @returns {Promise<{ id: object | string | null, action: 'created'|'skipped', hash: string }>}
 */
export async function createMemo(db, input) {
  const {
    kind,
    content,
    confidence,
    decayAnchor,
    meta: callerMeta = {},
    sourcePath,
    sessionId,
  } = input;
  if (!kind) throw new TypeError('createMemo: kind required');
  if (!content) throw new TypeError('createMemo: content required');

  const meta = {
    ...callerMeta,
    imported_from: 'v1',
    v1_source_path: sourcePath,
  };
  const hash = sha256(`${sourcePath}\n${canonicalPayload({ kind, content, confidence, meta })}`);
  if (await hashExists(db, hash)) {
    // Idempotent re-run: the exact same memo payload already imported.
    // Look up the prior row's target id so callers (Pass B's about-edge
    // writer) can still build downstream edges. Returning `id: null` here
    // is what caused the "upsertEdge: to: missing or invalid record ref"
    // cascade on re-imports.
    const prior = await findByHash(db, hash);
    return { id: parseRecordIdStr(prior?.target), action: 'skipped', hash };
  }

  const fields = {
    kind,
    content,
    content_hash: sha256(content),
    derived_by: 'v1-import',
    scope: 'global',
    tags: [],
    meta,
    ...(confidence !== undefined ? { confidence } : {}),
    // Pass the JS Date directly — SDK serializes to datetime. toISOString()
    // would produce a string and fail the schema's datetime coercion.
    ...(decayAnchor ? { decay_anchor: decayAnchor } : {}),
  };
  const { id } = await createWithLedger(db, {
    table: 'memos',
    fields,
    sourcePath,
    contentHash: hash,
    ledgerKind: 'memo',
    sessionId,
  });
  return { id, action: 'created', hash };
}

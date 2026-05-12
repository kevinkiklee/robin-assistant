// memo-writer.js — CREATE memo + ledger row, atomically.
//
// Embedding is NOT done here. Pass G runs `embeddings-backfill.js` after all
// passes complete; it covers events + memos + entities in one batch.

import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { createWithLedger } from '../tx.js';

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
    return { id: null, action: 'skipped', hash };
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
    ...(decayAnchor ? { decay_anchor: decayAnchor.toISOString() } : {}),
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

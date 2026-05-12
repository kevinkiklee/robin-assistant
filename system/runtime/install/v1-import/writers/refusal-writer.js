// refusal-writer.js — CREATE refusal + ledger row.
//
// Used for `memory/quarantine/` content: v1 refused to admit it (PII or
// similar). v2 keeps it in the discretion audit log only, never in memos.

import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { createWithLedger } from '../tx.js';

export async function createRefusal(db, input) {
  const {
    content,
    reason = 'v1-quarantine',
    direction = 'inbound',
    meta: callerMeta = {},
    sourcePath,
    sessionId,
  } = input;
  if (!content) throw new TypeError('createRefusal: content required');

  const meta = {
    ...callerMeta,
    imported_from: 'v1',
    from_v1: true,
    v1_source_path: sourcePath,
  };
  const hash = sha256(`${sourcePath}\n${JSON.stringify({ direction, content, reason, meta })}`);
  if (await hashExists(db, hash)) {
    return { id: null, action: 'skipped', hash };
  }

  const { id } = await createWithLedger(db, {
    table: 'refusals',
    fields: { direction, content, reason, meta },
    sourcePath,
    contentHash: hash,
    ledgerKind: 'refusal',
    sessionId,
  });
  return { id, action: 'created', hash };
}

// rule-writer.js — CREATE rule + ledger row.
//
// v1 preferences are pre-approved by the user (they wrote them down) so they
// go straight to the `rules` table active=true. Reflection / rule_candidates
// is a separate path used for corrections.

import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { createWithLedger } from '../tx.js';

export async function createRule(db, input) {
  const {
    content,
    kind = 'behavior',
    priority = 50,
    meta: callerMeta = {},
    sourcePath,
    sessionId,
  } = input;
  if (!content) throw new TypeError('createRule: content required');

  const meta = {
    ...callerMeta,
    imported_from: 'v1',
    v1_source_path: sourcePath,
  };
  const hash = sha256(`${sourcePath}\n${JSON.stringify({ kind, content, priority, meta })}`);
  if (await hashExists(db, hash)) {
    return { id: null, action: 'skipped', hash };
  }

  const { id } = await createWithLedger(db, {
    table: 'rules',
    fields: { content, kind, priority, active: true, meta },
    sourcePath,
    contentHash: hash,
    ledgerKind: 'rule',
    sessionId,
  });
  return { id, action: 'created', hash };
}

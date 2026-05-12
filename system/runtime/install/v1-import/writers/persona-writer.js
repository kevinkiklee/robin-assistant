// persona-writer.js — apply a v1 profile facet to the v2 persona singleton.
//
// Two writes per facet:
//   1. `memos(kind='profile_facet', meta.facet_slug=<slug>)` for the full body
//      (so content is reachable via FTS + vector recall).
//   2. UPSERT MERGE onto `persona:singleton` for any structured fields the
//      facet's projector emits.
//
// Each write has its own ledger entry. The memo is written first (always);
// the persona write is conditional on the projector producing fields.

import { sha256 } from '../../../../data/embed/hash.js';
import { hashExists } from '../ledger.js';
import { PERSONA_FACET_MAP } from '../taxonomy.js';
import { upsertWithLedger } from '../tx.js';
import { createMemo } from './memo-writer.js';

function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * @returns {Promise<{ memo: object, persona_action: 'written'|'skipped', hash: string }>}
 */
export async function applyFacet(db, input) {
  const { facet_slug, body, frontmatter, sourcePath, sessionId } = input;
  if (!facet_slug) throw new TypeError('applyFacet: facet_slug required');
  if (!body) throw new TypeError('applyFacet: body required');

  const memo = await createMemo(db, {
    kind: 'profile_facet',
    content: body,
    meta: { facet_slug },
    sourcePath,
    sessionId,
  });

  const projector = PERSONA_FACET_MAP[facet_slug];
  const projected = projector ? projector(body, frontmatter, { facet_slug }) : null;
  if (!projected || Object.keys(projected).length === 0) {
    return { memo, persona_action: 'skipped', hash: memo.hash };
  }

  const personaHash = sha256(`${sourcePath}\n${facet_slug}\n${canonicalize(projected)}`);
  if (await hashExists(db, personaHash)) {
    return { memo, persona_action: 'skipped', hash: personaHash };
  }

  await upsertWithLedger(db, {
    recordIdStr: 'persona:singleton',
    fields: projected,
    sourcePath,
    contentHash: personaHash,
    ledgerKind: 'persona_field',
    sessionId,
    mergeNotContent: true,
  });

  return { memo, persona_action: 'written', hash: personaHash };
}

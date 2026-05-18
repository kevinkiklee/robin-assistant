// system/tests/unit/migration-0034.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { close, connect } from '../../data/db/client.js';

test('migration 0034 adds derived_from_trust to entities/memos/edges/episodes/arcs', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    // Define minimal tables migration depends on (the init schema is loaded
    // by the runner in full integration; here we just verify 0034 is shaped right).
    await db
      .query(`
      DEFINE TABLE entities SCHEMAFULL; DEFINE FIELD name ON entities TYPE string;
      DEFINE TABLE memos    SCHEMAFULL;
      DEFINE TABLE edges    SCHEMAFULL TYPE RELATION;
      DEFINE TABLE episodes SCHEMAFULL;
      DEFINE TABLE arcs     SCHEMAFULL;
    `)
      .collect();
    const sql = await import('node:fs').then((m) =>
      m.readFileSync(
        new URL('../../data/db/migrations/0034-trust-propagation.surql', import.meta.url),
        'utf8',
      ),
    );
    await db.query(sql).collect();
    const [info] = await db.query('INFO FOR TABLE entities').collect();
    assert.ok(info?.fields?.derived_from_trust, 'entities.derived_from_trust defined');
    for (const t of ['memos', 'edges', 'episodes', 'arcs']) {
      const [r] = await db.query(`INFO FOR TABLE ${t}`).collect();
      assert.ok(r?.fields?.derived_from_trust, `${t}.derived_from_trust defined`);
    }
  } finally {
    await close(db);
  }
});

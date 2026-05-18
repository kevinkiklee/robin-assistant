// system/tests/unit/backfill-derived-trust.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, close } from '../../data/db/client.js';
import { backfillDerivedTrust } from '../../scripts/backfill-derived-trust.js';

async function setup() {
  const db = await connect({ engine: 'mem://' });
  await db.query(`
    DEFINE TABLE events SCHEMAFULL;
    DEFINE FIELD trust   ON events TYPE string DEFAULT 'trusted';
    DEFINE FIELD ts      ON events TYPE datetime DEFAULT time::now();

    DEFINE TABLE entities SCHEMAFULL;
    DEFINE FIELD name              ON entities TYPE string;
    DEFINE FIELD provenance        ON entities TYPE option<object> FLEXIBLE;
    DEFINE FIELD derived_from_trust ON entities TYPE string DEFAULT 'trusted';

    CREATE events:t1 SET trust='trusted';
    CREATE events:u1 SET trust='untrusted';
    CREATE entities:a SET name='Alice', provenance={ event_ids: ['events:t1'] };
    CREATE entities:b SET name='Bob',   provenance={ event_ids: ['events:u1'] };
    CREATE entities:c SET name='Carol', provenance={ event_ids: ['events:t1','events:u1'] };
  `).collect();
  return db;
}

test('backfill stamps derived_from_trust from cited events', async () => {
  const db = await setup();
  try {
    await backfillDerivedTrust(db);
    const [rows] = await db.query(
      `SELECT id, derived_from_trust FROM entities ORDER BY id`
    ).collect();
    const trustByName = Object.fromEntries(
      rows.map(r => [String(r.id).replace('entities:', ''), r.derived_from_trust])
    );
    assert.equal(trustByName.a, 'trusted');
    assert.equal(trustByName.b, 'untrusted');
    assert.equal(trustByName.c, 'untrusted');
  } finally {
    await close(db);
  }
});

test('backfill is idempotent', async () => {
  const db = await setup();
  try {
    await backfillDerivedTrust(db);
    await backfillDerivedTrust(db); // run twice
    const [rows] = await db.query(`SELECT derived_from_trust FROM entities:b`).collect();
    assert.equal(rows[0].derived_from_trust, 'untrusted');
  } finally {
    await close(db);
  }
});

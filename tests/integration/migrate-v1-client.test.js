import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { listTableCount, openV1, scanTable } from '../../src/migrate-v1/v1-client.js';

// Note: We deliberately avoid a "seed via @surrealdb/node, close, reopen via openV1"
// pattern in the same process — the rocksdb engine doesn't release its file lock
// synchronously on close, so a same-process reopen can hang. End-to-end migration
// flows are covered by the orchestrator integration test (T13) which runs the full
// seed→openV1→migrate path through a single connection chain.

test('openV1 throws on missing path', async () => {
  await assert.rejects(() => openV1('/nonexistent/path/that/should/not/exist'), /not found/);
});

test('openV1 + listTableCount + scanTable round-trip on a fresh-but-empty rocksdb dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1-client-empty-'));
  const v1 = await openV1(dir);
  try {
    // listTableCount on a table that doesn't exist returns 0, not throws.
    const n = await listTableCount(v1, 'capture');
    assert.equal(n, 0);

    // Define + populate a table through the same handle so we exercise scanTable
    // without re-opening the rocksdb path mid-test.
    await v1.query('DEFINE TABLE capture SCHEMALESS;').collect();
    await v1.query(surql`CREATE capture:c1 SET body = 'hello', ts = time::now()`).collect();
    await v1.query(surql`CREATE capture:c2 SET body = 'world', ts = time::now()`).collect();

    assert.equal(await listTableCount(v1, 'capture'), 2);

    const rows = [];
    for await (const batch of scanTable(v1, 'capture', { batch: 100 })) {
      rows.push(...batch);
    }
    assert.equal(rows.length, 2);
    assert.ok(rows[0].body);
  } finally {
    await v1.close();
  }
});

test('listTableCount sanitises table names against injection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v1-client-safe-'));
  const v1 = await openV1(dir);
  try {
    // Garbage chars are stripped; query falls through to count() on empty/missing table.
    const n = await listTableCount(v1, 'capture; DROP DATABASE main; --');
    assert.equal(n, 0);
  } finally {
    await v1.close();
  }
});

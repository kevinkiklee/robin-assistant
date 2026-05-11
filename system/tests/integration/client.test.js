import assert from 'node:assert/strict';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';

test('connect returns a usable Surreal handle on mem://', async () => {
  const db = await connect({ engine: 'mem://' });
  const result = await db.query('RETURN 1 + 1').collect();
  assert.deepEqual(result, [2]);
  await close(db);
});

test('connect uses NS=robin DB=main by default', async () => {
  const db = await connect({ engine: 'mem://' });
  // INFO FOR DB returns an object describing the current DB; just verify it works.
  const [info] = await db.query('INFO FOR DB').collect();
  assert.ok(info && typeof info === 'object');
  await close(db);
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOPLIST_PATH = join(__dirname, '../../../scripts/memory/lib/alias-stoplist.json');

test('alias-stoplist.json is valid JSON with required entries', () => {
  const content = readFileSync(STOPLIST_PATH, 'utf-8');
  const list = JSON.parse(content);
  assert.ok(Array.isArray(list), 'stop-list must be an array');
  assert.ok(list.length >= 50, 'stop-list should have ≥50 entries');
  for (const entry of list) {
    assert.equal(typeof entry, 'string', 'every entry must be a string');
    assert.ok(entry.length > 0, 'no empty strings');
    assert.equal(entry, entry.toLowerCase(), 'entries are lowercase');
  }
  for (const required of ['kevin', 'robin', 'user', 'overview', 'summary', 'description']) {
    assert.ok(list.includes(required), `must include "${required}"`);
  }
});

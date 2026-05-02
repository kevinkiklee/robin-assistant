import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const inboxPath = fileURLToPath(new URL('../../../user-data/memory/streams/inbox.md', import.meta.url));

test('inbox IDs are well-formed and unique', () => {
  if (!existsSync(inboxPath)) return; // user-data may not be populated in CI
  const content = readFileSync(inboxPath, 'utf-8');
  const ids = [...content.matchAll(/<!--\s*id:\s*([^\s>]+)\s*-->/g)].map(m => m[1]);
  for (const id of ids) {
    // Format: YYYYMMDD-HHMM-slug, where slug is alphanumeric + hyphens
    // (e.g. `20260429-2200-finance-bh-payboo`).
    assert.match(id, /^\d{8}-\d{4}-\w[\w-]*\w$/, `malformed id in inbox.md: ${id}`);
  }
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate inbox ids: ${dupes.join(', ')}`);
});

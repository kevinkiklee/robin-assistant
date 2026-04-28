import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIndex } from '../scripts/regenerate-operations-index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SYSTEM = fileURLToPath(new URL('..', import.meta.url));

test('committed INDEX.md matches generated content', () => {
  const generated = generateIndex(join(SYSTEM, 'operations'));
  const committed = readFileSync(join(SYSTEM, 'operations/INDEX.md'), 'utf-8');
  assert.equal(committed.trim(), generated.trim());
});

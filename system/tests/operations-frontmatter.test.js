import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOperation } from '../scripts/lib/operations.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OPS = fileURLToPath(new URL('../operations', import.meta.url));

test('every operation has parseable frontmatter with name + description', () => {
  for (const f of readdirSync(OPS)) {
    if (f === 'INDEX.md' || !f.endsWith('.md')) continue;
    const parsed = parseOperation(readFileSync(join(OPS, f), 'utf-8'));
    assert.ok(parsed.name, `${f} missing frontmatter.name`);
    assert.ok(parsed.description, `${f} missing frontmatter.description`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePointers } from '../core/scripts/regenerate-pointers.js';
import { PLATFORMS } from '../core/scripts/lib/platforms.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every platform with a pointerFile has a matching root file', () => {
  for (const [name, p] of Object.entries(PLATFORMS)) {
    if (!p.pointerFile) continue;
    const path = join(REPO_ROOT, p.pointerFile);
    assert.ok(existsSync(path), `missing root pointer: ${p.pointerFile}`);
    const content = readFileSync(path, 'utf-8');
    assert.equal(content.trim(), p.pointerContent.trim(),
      `${p.pointerFile} drift from platforms.js`);
  }
});

test('generatePointers writes content matching platforms.js', () => {
  const out = generatePointers();
  for (const [name, p] of Object.entries(PLATFORMS)) {
    if (!p.pointerFile) continue;
    assert.equal(out[p.pointerFile].trim(), p.pointerContent.trim());
  }
});

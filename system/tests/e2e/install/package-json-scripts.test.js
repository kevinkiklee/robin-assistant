// system/tests/e2e/install/package-json-scripts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('install: package.json scripts surface', () => {
  it('contains exactly the 5 surviving scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const expected = ['postinstall', 'test', 'test:e2e', 'test:install', 'test:unit'].sort();
    const actual = Object.keys(pkg.scripts).sort();
    assert.deepEqual(actual, expected,
      `package.json scripts mismatch.\nexpected: ${expected.join(', ')}\nactual:   ${actual.join(', ')}`);
  });

  it('does not re-introduce deleted scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const banned = [
      'backup', 'restore', 'reset', 'regenerate-memory-index', 'sync-lunch-money',
      'analyze-finances', 'regenerate-links', 'measure-tokens', 'measure-prefix-bloat',
      'check-plugin-prefix', 'check-protocol-triggers', 'lint-memory', 'densify-wiki',
      'golden-session', 'prune-preview', 'prune-execute', 'migrate-auto-memory',
      'jobs', 'jobs:sync', 'jobs:list',
      'discord:auth', 'discord:install', 'discord:uninstall', 'discord:status', 'discord:health',
    ];
    for (const name of banned) {
      assert.ok(!(name in pkg.scripts), `banned script re-introduced: ${name}`);
    }
  });
});

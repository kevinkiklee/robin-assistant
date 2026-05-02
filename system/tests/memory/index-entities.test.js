// system/tests/index-entities.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'system/scripts/memory/index-entities.js');

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'index-entities-'));
  mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
    '---\ntype: entity\nallies: []\naliases: [Park]\n---\n# Dr. Park\n');
  return ws;
}

function run(ws, args) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: ws, encoding: 'utf8', env: { ...process.env, ROBIN_WORKSPACE: ws } });
}

describe('index-entities CLI', () => {
  it('--regenerate writes ENTITIES.md', () => {
    const ws = setup();
    const r = run(ws, ['--regenerate']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(ws, 'user-data/memory/ENTITIES.md')));
  });

  it('--regenerate is idempotent (no-op when content unchanged)', () => {
    const ws = setup();
    run(ws, ['--regenerate']);
    const stat1 = readFileSync(join(ws, 'user-data/state/entities-hash.txt'), 'utf8');
    run(ws, ['--regenerate']);
    const stat2 = readFileSync(join(ws, 'user-data/state/entities-hash.txt'), 'utf8');
    assert.equal(stat1, stat2);
  });

  it('--regenerate aborts when user edited ENTITIES.md', () => {
    const ws = setup();
    run(ws, ['--regenerate']);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n- Manual entry — x.md\n');
    const r = run(ws, ['--regenerate']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /user-edited/i);
  });

  it('--bootstrap reports files needing aliases', () => {
    const ws = setup();
    const r = run(ws, ['--bootstrap']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Indexed/);
  });
});

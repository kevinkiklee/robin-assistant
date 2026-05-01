// Cycle-2c: PII-write hook + high-stakes audit + S8 acceptance.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHighStakesDestination, appendHighStakesWrite, HIGH_STAKES_DESTINATIONS } from '../scripts/lib/high-stakes-log.js';
import { migrateCycle2c } from '../scripts/migrate-cycle-2c.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(__dirname, '..', 'scripts', 'claude-code-hook.js');

function ws() { return mkdtempSync(join(tmpdir(), 'cycle2c-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function runHook(workspaceDir, event) {
  return spawnSync('node', [HOOK_SCRIPT, '--on-pre-tool-use'], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ROBIN_WORKSPACE: workspaceDir },
  });
}

test('high-stakes destinations list is non-empty and includes expected paths', () => {
  assert.ok(HIGH_STAKES_DESTINATIONS.length >= 5);
  assert.ok(HIGH_STAKES_DESTINATIONS.includes('user-data/memory/tasks.md'));
  assert.ok(HIGH_STAKES_DESTINATIONS.includes('user-data/memory/decisions.md'));
});

test('isHighStakesDestination: matches exact + suffix paths', () => {
  assert.equal(isHighStakesDestination('user-data/memory/tasks.md'), true);
  assert.equal(isHighStakesDestination('/abs/path/user-data/memory/decisions.md'), true);
  assert.equal(isHighStakesDestination('user-data/memory/journal.md'), false);
  assert.equal(isHighStakesDestination('user-data/memory/knowledge/foo.md'), false);
});

test('appendHighStakesWrite: writes a TSV entry', () => {
  const w = ws();
  try {
    appendHighStakesWrite(w, { target: 'user-data/memory/tasks.md', contentHash: 'abc12345' });
    const log = readFileSync(join(w, 'user-data/state/high-stakes-writes.log'), 'utf-8');
    assert.match(log, /\tuser-data\/memory\/tasks\.md\tabc12345/);
  } finally {
    clean(w);
  }
});

test('appendHighStakesWrite: dedup within 1h (same target+hash → 1 entry)', () => {
  const w = ws();
  try {
    appendHighStakesWrite(w, { target: 'user-data/memory/tasks.md', contentHash: 'h1' });
    appendHighStakesWrite(w, { target: 'user-data/memory/tasks.md', contentHash: 'h1' });
    appendHighStakesWrite(w, { target: 'user-data/memory/tasks.md', contentHash: 'h2' });
    const log = readFileSync(join(w, 'user-data/state/high-stakes-writes.log'), 'utf-8');
    const lines = log.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
  } finally {
    clean(w);
  }
});

test('S8: PII content in Write to user-data/memory/* → blocked at hook layer', () => {
  const w = ws();
  try {
    const event = {
      tool_name: 'Write',
      tool_input: {
        file_path: join(w, 'user-data/memory/journal.md'),
        content: 'My SSN is 123-45-6789 — please remember.',
      },
    };
    const r = runHook(w, event);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /WRITE_REFUSED \[pii\]/);
    // Refusal log entry.
    const log = readFileSync(join(w, 'user-data/state/policy-refusals.log'), 'utf-8');
    assert.match(log, /\tpii-bypass\t/);
  } finally {
    clean(w);
  }
});

test('PII pattern in non-memory write is allowed', () => {
  const w = ws();
  try {
    const event = {
      tool_name: 'Write',
      tool_input: {
        file_path: join(w, 'tmp/notes.txt'),
        content: 'My SSN is 123-45-6789.',
      },
    };
    const r = runHook(w, event);
    assert.equal(r.status, 0);
  } finally {
    clean(w);
  }
});

test('high-stakes write to user-data/memory/tasks.md → allowed + audited', () => {
  const w = ws();
  try {
    const event = {
      tool_name: 'Write',
      tool_input: {
        file_path: join(w, 'user-data/memory/tasks.md'),
        content: '# tasks\n- [ ] new task\n',
      },
    };
    const r = runHook(w, event);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const log = readFileSync(join(w, 'user-data/state/high-stakes-writes.log'), 'utf-8');
    assert.match(log, /tasks\.md/);
  } finally {
    clean(w);
  }
});

test('migrate-cycle-2c: stamps last_fired+fired_count on existing patterns', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/memory/self-improvement'), { recursive: true });
    writeFileSync(join(w, 'user-data/memory/self-improvement/patterns.md'),
      `# Patterns\n\n## P1\n---\nname: p1\n---\nbody\n`);
    const r = migrateCycle2c(w);
    assert.equal(r.patterns.stamped, 1);
    const after = readFileSync(join(w, 'user-data/memory/self-improvement/patterns.md'), 'utf-8');
    assert.match(after, /last_fired:/);
    assert.match(after, /fired_count: 0/);
  } finally {
    clean(w);
  }
});

test('migrate-cycle-2c: bumps manifest v1 → v2', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/security'), { recursive: true });
    writeFileSync(join(w, 'user-data/security/manifest.json'), JSON.stringify({
      version: 1,
      hooks: {},
      mcpServers: { expected: [], writeCapable: [] },
    }));
    const r = migrateCycle2c(w);
    assert.equal(r.manifest.migrated, true);
    const after = JSON.parse(readFileSync(join(w, 'user-data/security/manifest.json'), 'utf-8'));
    assert.equal(after.version, 2);
    assert.deepEqual(after.agentsmd, { hardRulesHash: '', lastSnapshot: '' });
    assert.deepEqual(after.userDataJobs, { knownFiles: [] });
  } finally {
    clean(w);
  }
});

test('migrate-cycle-2c: idempotent', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/memory/self-improvement'), { recursive: true });
    writeFileSync(join(w, 'user-data/memory/self-improvement/patterns.md'),
      `# Patterns\n\n## P1\n---\nname: p1\nlast_fired: 2026-04-30\nfired_count: 5\n---\nbody\n`);
    const r1 = migrateCycle2c(w);
    assert.equal(r1.patterns.stamped, 0);
    const r2 = migrateCycle2c(w);
    assert.equal(r2.patterns.stamped, 0);
  } finally {
    clean(w);
  }
});

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, computeSyncHash } from '../../../scripts/jobs/reconciler.js';
import { jobsPaths } from '../../../scripts/lib/jobs/paths.js';

let workspaceDir;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'jobs-reconciler-'));
  mkdirSync(join(workspaceDir, 'system/jobs'), { recursive: true });
  mkdirSync(join(workspaceDir, 'user-data/jobs'), { recursive: true });
  mkdirSync(join(workspaceDir, 'user-data/state/jobs'), { recursive: true });
  writeFileSync(
    join(workspaceDir, 'user-data/robin.config.json'),
    JSON.stringify({ user: { timezone: 'UTC' } })
  );
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function fakeAdapter() {
  const installed = new Map();
  return {
    platform: 'fake',
    batched: false,
    listEntries: () => [...installed.keys()],
    installEntry: ({ name, schedule, workspaceDir: ws }) => {
      installed.set(name, { schedule, workspaceDir: ws });
      return { ok: true };
    },
    uninstallEntry: (name) => {
      installed.delete(name);
      return { ok: true };
    },
    isHealthy: () => true,
    _state: installed,
  };
}

function writeJob(name, frontmatter, body = '', dir = 'user-data/jobs') {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = Object.entries(v)
          .map(([k2, v2]) => `  ${k2}: "${v2}"`)
          .join('\n');
        return `${k}:\n${inner}`;
      }
      if (Array.isArray(v)) return `${k}: [${v.map((x) => `"${x}"`).join(', ')}]`;
      if (typeof v === 'string') return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join('\n');
  const content = `---\n${fm}\n---\n${body}`;
  writeFileSync(join(workspaceDir, dir, `${name}.md`), content);
}

describe('reconcile sync cycle', () => {
  test('adds missing entries', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    writeJob('b', { name: 'b', description: 'd', runtime: 'node', schedule: '0 3 * * *', command: 'echo' });
    const adapter = fakeAdapter();
    const r = reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.equal(r.ok, true);
    assert.deepEqual([...r.added].sort(), ['a', 'b']);
    assert.equal(adapter._state.size, 2);
  });

  test('removes orphaned entries', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const adapter = fakeAdapter();
    adapter._state.set('legacy', { schedule: '0 5 * * *', workspaceDir });
    const r = reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.deepEqual(r.removed, ['legacy']);
    assert.equal(adapter._state.has('legacy'), false);
  });

  test('skips disabled jobs', () => {
    writeJob('off', {
      name: 'off',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'echo',
      enabled: false,
    });
    const adapter = fakeAdapter();
    const r = reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.equal(adapter._state.has('off'), false);
    assert.equal(r.added.includes('off'), false);
  });

  test('regenerates INDEX/upcoming/failures and writes hash', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const adapter = fakeAdapter();
    reconcile({ workspaceDir, argv: ['/robin'], adapter });
    const paths = jobsPaths(workspaceDir);
    assert.match(readFileSync(paths.indexMd, 'utf-8'), /\| a \|/);
    assert.ok(readFileSync(paths.upcomingMd, 'utf-8').length > 0);
    assert.ok(readFileSync(paths.failuresMd, 'utf-8').length > 0);
    assert.ok(readFileSync(paths.syncHashFile, 'utf-8').length === 64);
    assert.equal(readFileSync(paths.workspacePathFile, 'utf-8'), workspaceDir);
  });

  test('hash early-exit on second invocation when nothing changed', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const adapter = fakeAdapter();
    reconcile({ workspaceDir, argv: ['/robin'], adapter });
    const r2 = reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.equal(r2.skipped, 'no-change');
  });

  test('orphan state JSON is cleaned up', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const paths = jobsPaths(workspaceDir);
    writeFileSync(paths.stateJSON('orphan'), JSON.stringify({ name: 'orphan' }));
    const adapter = fakeAdapter();
    const r = reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.deepEqual(r.orphansRemoved, ['orphan']);
  });

  test('shallow override: system/jobs/x.md + user-data/jobs/x.md (override:) merges', () => {
    writeJob(
      'x',
      { name: 'x', description: 'd', runtime: 'node', schedule: '0 5 * * *', command: 'echo', enabled: true },
      '',
      'system/jobs'
    );
    writeJob('x', { override: 'x', enabled: false }, '');
    const adapter = fakeAdapter();
    reconcile({ workspaceDir, argv: ['/robin'], adapter });
    // Should NOT install (overridden enabled: false)
    assert.equal(adapter._state.has('x'), false);
  });

  test('full override: user-data/jobs/x.md without override: replaces system schedule', () => {
    writeJob(
      'x',
      { name: 'x', description: 'sys', runtime: 'node', schedule: '0 5 * * *', command: 'echo' },
      '',
      'system/jobs'
    );
    writeJob('x', { name: 'x', description: 'usr', runtime: 'node', schedule: '0 6 * * *', command: 'echo' });
    const adapter = fakeAdapter();
    reconcile({ workspaceDir, argv: ['/robin'], adapter });
    assert.equal(adapter._state.get('x').schedule, '0 6 * * *');
  });
});

describe('computeSyncHash', () => {
  test('changes when a file changes', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const h1 = computeSyncHash(workspaceDir);
    writeJob('a', { name: 'a', description: 'd2', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const h2 = computeSyncHash(workspaceDir);
    assert.notEqual(h1, h2);
  });

  test('stable when nothing changes', () => {
    writeJob('a', { name: 'a', description: 'd', runtime: 'node', schedule: '0 4 * * *', command: 'echo' });
    const h1 = computeSyncHash(workspaceDir);
    const h2 = computeSyncHash(workspaceDir);
    assert.equal(h1, h2);
  });
});

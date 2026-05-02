import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkJobDefs, checkPlists, checkStaleness, renderHealthSection, runDoctor } from '../../../scripts/jobs/lib/doctor.js';
import { generatePlist, LABEL_PREFIX } from '../../../scripts/jobs/installer/launchd.js';

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-test-'));
  return dir;
}
function jobDef(name, frontmatter) {
  return [name, { frontmatter }];
}

describe('doctor: checkJobDefs', () => {
  test('passes when command script exists', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'user-data/runtime/scripts'), { recursive: true });
    writeFileSync(join(ws, 'user-data/runtime/scripts/sync-x.js'), 'export {};');
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', command: 'node user-data/runtime/scripts/sync-x.js' })]);
    const r = checkJobDefs(ws, jobs);
    assert.deepEqual(r, []);
    rmSync(ws, { recursive: true, force: true });
  });

  test('flags missing script path', () => {
    const ws = tempWorkspace();
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', command: 'node user-data/runtime/scripts/missing.js' })]);
    const r = checkJobDefs(ws, jobs);
    assert.equal(r.length, 1);
    assert.equal(r[0].code, 'job-def-script-missing');
    assert.equal(r[0].severity, 'error');
    assert.equal(r[0].target, 'sync-x');
    rmSync(ws, { recursive: true, force: true });
  });

  test('skips disabled and non-node jobs', () => {
    const ws = tempWorkspace();
    const jobs = new Map([
      jobDef('disabled', { enabled: false, runtime: 'node', command: 'node missing.js' }),
      jobDef('agent', { enabled: true, runtime: 'agent' }),
    ]);
    assert.deepEqual(checkJobDefs(ws, jobs), []);
    rmSync(ws, { recursive: true, force: true });
  });

  test('flags runtime=node with no command', () => {
    const ws = tempWorkspace();
    const jobs = new Map([jobDef('broken', { enabled: true, runtime: 'node' })]);
    const r = checkJobDefs(ws, jobs);
    assert.equal(r[0].code, 'job-def-no-command');
  });
});

describe('doctor: checkPlists', () => {
  function setupPlistEnv() {
    const ws = tempWorkspace();
    const agentsDir = mkdtempSync(join(tmpdir(), 'doctor-agents-'));
    mkdirSync(join(ws, 'bin'), { recursive: true });
    writeFileSync(join(ws, 'bin/robin.js'), '');
    return { ws, agentsDir };
  }
  // helper to write a plist with custom path/wd/PATH
  function writePlist(agentsDir, name, { argv, wd, path }) {
    const xml = generatePlist({ name, argv, workspaceDir: wd, schedule: '0 4 * * *', envPath: path });
    writeFileSync(join(agentsDir, `${LABEL_PREFIX}${name}.plist`), xml);
  }
  function opts(agentsDir) {
    return {
      agentsDir: () => agentsDir,
      listEntries: () => {
        return [];
      },
      plistPath: (n) => join(agentsDir, `${LABEL_PREFIX}${n}.plist`),
    };
  }

  test('orphan plist: installed but no matching job def', () => {
    const { ws, agentsDir } = setupPlistEnv();
    writePlist(agentsDir, 'host-validation', { argv: ['/usr/bin/node', '/x.js'], wd: ws, path: '/usr/bin' });
    const jobs = new Map();
    const o = opts(agentsDir);
    o.listEntries = () => ['host-validation'];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-orphan' && x.target === 'host-validation'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });

  test('workspace mismatch: plist points at different repo dir', () => {
    const { ws, agentsDir } = setupPlistEnv();
    writePlist(agentsDir, 'sync-x', { argv: ['/usr/bin/node', '/x.js'], wd: '/some/other/path', path: '/usr/bin:' + process.execPath.replace(/\/[^/]+$/, '') });
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', schedule: '0 4 * * *' })]);
    const o = opts(agentsDir);
    o.listEntries = () => ['sync-x'];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-workspace-mismatch' && x.target === 'sync-x'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });

  test('argv missing: plist references nonexistent script', () => {
    const { ws, agentsDir } = setupPlistEnv();
    writePlist(agentsDir, 'sync-x', { argv: ['/usr/bin/node', '/nonexistent/x.js'], wd: ws, path: '/usr/bin:' + process.execPath.replace(/\/[^/]+$/, '') });
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', schedule: '0 4 * * *' })]);
    const o = opts(agentsDir);
    o.listEntries = () => ['sync-x'];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-argv-missing' && x.target === 'sync-x'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });

  test('PATH missing node for runtime=node', () => {
    const { ws, agentsDir } = setupPlistEnv();
    writePlist(agentsDir, 'sync-x', { argv: [process.execPath, join(ws, 'bin/robin.js')], wd: ws, path: '/no/binaries/here' });
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', schedule: '0 4 * * *' })]);
    const o = opts(agentsDir);
    o.listEntries = () => ['sync-x'];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-path-no-node'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });

  test('PATH missing claude for runtime=agent', () => {
    const { ws, agentsDir } = setupPlistEnv();
    const nodeDir = process.execPath.replace(/\/[^/]+$/, '');
    writePlist(agentsDir, 'dream', { argv: [process.execPath, join(ws, 'bin/robin.js')], wd: ws, path: nodeDir });
    const jobs = new Map([jobDef('dream', { enabled: true, runtime: 'agent', schedule: '0 4 * * *' })]);
    const o = opts(agentsDir);
    o.listEntries = () => ['dream'];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-path-no-claude'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });

  test('enabled job with no installed plist', () => {
    const { ws, agentsDir } = setupPlistEnv();
    const jobs = new Map([jobDef('sync-x', { enabled: true, runtime: 'node', schedule: '0 4 * * *' })]);
    const o = opts(agentsDir);
    o.listEntries = () => [];
    const r = checkPlists(ws, jobs, o);
    assert.ok(r.find((x) => x.code === 'plist-missing' && x.target === 'sync-x'));
    rmSync(ws, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  });
});

describe('doctor: renderHealthSection', () => {
  test('empty findings → (none)', () => {
    const out = renderHealthSection([]);
    assert.match(out, /## Health check/);
    assert.match(out, /\(none\)/);
  });

  test('findings render as table sorted error-first', () => {
    const findings = [
      { severity: 'warn', code: 'plist-orphan', target: 'foo', message: 'orphan' },
      { severity: 'error', code: 'plist-missing', target: 'bar', message: 'missing' },
    ];
    const out = renderHealthSection(findings);
    const errIdx = out.indexOf('plist-missing');
    const warnIdx = out.indexOf('plist-orphan');
    assert.ok(errIdx > 0 && warnIdx > 0 && errIdx < warnIdx, 'errors must precede warns');
  });

  test('escapes pipes in message', () => {
    const out = renderHealthSection([{ severity: 'error', code: 'x', target: 'y', message: 'a | b' }]);
    assert.match(out, /a \\\| b/);
  });
});

describe('doctor: checkStaleness', () => {
  test('flags enabled job with no state', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', schedule: '0 3 * * *' })]);
    const r = checkStaleness('/ws', jobs, new Map());
    assert.equal(r.length, 1);
    assert.equal(r[0].code, 'job-never-ran');
    assert.equal(r[0].severity, 'warn');
    assert.equal(r[0].target, 'x');
  });

  test('flags enabled job whose state has no last_run_at', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', schedule: '0 3 * * *' })]);
    const states = new Map([['x', { name: 'x', last_run_at: null }]]);
    const r = checkStaleness('/ws', jobs, states);
    assert.equal(r.length, 1);
    assert.equal(r[0].code, 'job-never-ran');
  });

  test('skips disabled jobs', () => {
    const jobs = new Map([jobDef('x', { enabled: false, runtime: 'node', schedule: '0 3 * * *' })]);
    assert.deepEqual(checkStaleness('/ws', jobs, new Map()), []);
  });

  test('skips jobs without schedule', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node' })]);
    assert.deepEqual(checkStaleness('/ws', jobs, new Map()), []);
  });

  test('flags overdue job (next_run_at >2x interval in past)', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', schedule: '0 3 * * *' })]);
    // daily cron; 3 days ago is well past 2x interval
    const states = new Map([
      ['x', { name: 'x', last_run_at: '2026-04-29T07:00:00Z', next_run_at: '2026-04-30T07:00:00Z' }],
    ]);
    const now = new Date('2026-05-03T07:00:00Z');
    const r = checkStaleness('/ws', jobs, states, { now });
    assert.equal(r.length, 1);
    assert.equal(r[0].code, 'job-overdue');
    assert.equal(r[0].severity, 'warn');
  });

  test('does not flag job within grace window', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', schedule: '0 3 * * *' })]);
    // daily cron; next_run_at is in the future — healthy
    const states = new Map([
      ['x', { name: 'x', last_run_at: '2026-05-02T07:00:00Z', next_run_at: '2026-05-03T07:00:00Z' }],
    ]);
    const now = new Date('2026-05-02T15:00:00Z');
    assert.deepEqual(checkStaleness('/ws', jobs, states, { now }), []);
  });

  test('returns [] when states is undefined', () => {
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', schedule: '0 3 * * *' })]);
    assert.deepEqual(checkStaleness('/ws', jobs, undefined), []);
  });
});

describe('doctor: runDoctor wraps both checks', () => {
  test('no agents dir → returns only job-def findings cleanly', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'user-data/runtime/scripts'), { recursive: true });
    writeFileSync(join(ws, 'user-data/runtime/scripts/x.js'), 'export {};');
    const jobs = new Map([jobDef('x', { enabled: true, runtime: 'node', command: 'node user-data/runtime/scripts/x.js' })]);
    const r = runDoctor(ws, jobs, {
      agentsDir: () => '/nonexistent-launchagents-dir-doctor-test',
      listEntries: () => [],
      plistPath: () => '/x',
    });
    assert.deepEqual(r, []);
    rmSync(ws, { recursive: true, force: true });
  });
});

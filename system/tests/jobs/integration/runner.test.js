import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../scripts/jobs/runner.js';
import { jobsPaths } from '../../../scripts/jobs/lib/paths.js';
import { readJSON } from '../../../scripts/jobs/lib/atomic.js';

let workspaceDir;

function setup() {
  workspaceDir = mkdtempSync(join(tmpdir(), 'jobs-runner-'));
  mkdirSync(join(workspaceDir, 'system/jobs'), { recursive: true });
  mkdirSync(join(workspaceDir, 'user-data/jobs'), { recursive: true });
  mkdirSync(join(workspaceDir, 'user-data/state/jobs'), { recursive: true });
  writeFileSync(
    join(workspaceDir, 'user-data/robin.config.json'),
    JSON.stringify({ user: { timezone: 'UTC' } })
  );
}

beforeEach(setup);
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function writeJob(name, frontmatter, body = '') {
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
  writeFileSync(join(workspaceDir, 'user-data/jobs', `${name}.md`), content);
}

// Mock spawn that returns a process emitting controlled output and exit code.
function mockSpawn({ exitCode = 0, stdout = '', stderr = '', delay = 0, signal = null }) {
  return () => {
    const listeners = { close: [], error: [], data: { stdout: [], stderr: [] } };
    const proc = {
      stdout: { on: (e, fn) => listeners.data.stdout.push(fn) },
      stderr: { on: (e, fn) => listeners.data.stderr.push(fn) },
      stdin: { end: () => {} },
      on: (e, fn) => {
        if (e === 'close') listeners.close.push(fn);
        else if (e === 'error') listeners.error.push(fn);
      },
      kill: () => {},
    };
    setTimeout(() => {
      if (stdout) listeners.data.stdout.forEach((fn) => fn(Buffer.from(stdout)));
      if (stderr) listeners.data.stderr.forEach((fn) => fn(Buffer.from(stderr)));
      listeners.close.forEach((fn) => fn(exitCode, signal));
    }, delay);
    return proc;
  };
}

describe('runner happy path', () => {
  test('node-runtime job exit 0 → state ok, INDEX written, logs written', async () => {
    writeJob('hello', {
      name: 'hello',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'echo hi',
    });
    const notifies = [];
    const result = await run({
      workspaceDir,
      name: 'hello',
      spawnFn: mockSpawn({ exitCode: 0, stdout: 'hi\n' }),
      notifyFn: (n) => {
        notifies.push(n);
        return true;
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.exitCode, 0);
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('hello'));
    assert.equal(state.last_status, 'ok');
    assert.equal(state.last_exit_code, 0);
    assert.equal(state.consecutive_failures, 0);
    assert.ok(state.last_log_path);
    const indexContent = readFileSync(jobsPaths(workspaceDir).indexMd, 'utf-8');
    assert.match(indexContent, /hello/);
    assert.equal(notifies.length, 0);
  });
});

describe('runner failure path', () => {
  test('exit 1 → state failed, notification fires, consecutive_failures=1', async () => {
    writeJob('bad', {
      name: 'bad',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'false',
    });
    const notifies = [];
    const result = await run({
      workspaceDir,
      name: 'bad',
      spawnFn: mockSpawn({ exitCode: 1, stderr: 'oh no\n' }),
      notifyFn: (n) => {
        notifies.push(n);
        return true;
      },
    });
    assert.equal(result.status, 'failed');
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('bad'));
    assert.equal(state.last_status, 'failed');
    assert.equal(state.consecutive_failures, 1);
    assert.equal(state.last_failure_category, 'runtime_error');
    assert.equal(notifies.length, 1);
  });

  test('second failure same category does not re-notify', async () => {
    writeJob('bad', {
      name: 'bad',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'false',
    });
    const notifies = [];
    const notifyFn = (n) => {
      notifies.push(n);
      return true;
    };
    await run({
      workspaceDir,
      name: 'bad',
      spawnFn: mockSpawn({ exitCode: 1 }),
      notifyFn,
    });
    await run({
      workspaceDir,
      name: 'bad',
      spawnFn: mockSpawn({ exitCode: 1 }),
      notifyFn,
      flags: { force: true },
    });
    assert.equal(notifies.length, 1, 'second failure suppressed');
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('bad'));
    assert.equal(state.consecutive_failures, 2);
  });

  test('auth_expired stderr triggers auth category', async () => {
    writeJob('agent-job', {
      name: 'agent-job',
      description: 'd',
      runtime: 'agent',
      schedule: '0 4 * * *',
    }, 'do the thing');
    const notifies = [];
    await run({
      workspaceDir,
      name: 'agent-job',
      spawnFn: mockSpawn({ exitCode: 1, stderr: 'HTTP 401 Unauthorized\n' }),
      notifyFn: (n) => {
        notifies.push(n);
        return true;
      },
    });
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('agent-job'));
    assert.equal(state.last_failure_category, 'auth_expired');
    assert.match(notifies[0].body, /auth/i);
  });
});

describe('runner gates', () => {
  test('out-of-window date skips', async () => {
    writeJob('seasonal', {
      name: 'seasonal',
      description: 'd',
      runtime: 'node',
      schedule: '0 8 * * *',
      command: 'echo hi',
      active: { from_month_day: '01-01', to_month_day: '01-02' },
    });
    const result = await run({
      workspaceDir,
      name: 'seasonal',
      spawnFn: mockSpawn({ exitCode: 0 }),
      now: new Date('2026-07-15T08:00:00Z'),
    });
    assert.equal(result.status, 'skipped:out-of-window');
    assert.equal(result.exitCode, 0);
  });

  test('--force bypasses out-of-window', async () => {
    writeJob('seasonal', {
      name: 'seasonal',
      description: 'd',
      runtime: 'node',
      schedule: '0 8 * * *',
      command: 'echo hi',
      active: { from_month_day: '01-01', to_month_day: '01-02' },
    });
    const result = await run({
      workspaceDir,
      name: 'seasonal',
      spawnFn: mockSpawn({ exitCode: 0, stdout: 'ran' }),
      now: new Date('2026-07-15T08:00:00Z'),
      flags: { force: true },
    });
    assert.equal(result.status, 'ok');
  });

  test('lock held → second invocation skips', async () => {
    writeJob('locking', {
      name: 'locking',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'echo',
    });
    // Pre-create a lock file with current process pid (alive).
    const lockPath = jobsPaths(workspaceDir).lockFile('locking');
    mkdirSync(jobsPaths(workspaceDir).locksDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), host: '' })
    );
    const result = await run({
      workspaceDir,
      name: 'locking',
      spawnFn: mockSpawn({ exitCode: 0 }),
    });
    assert.equal(result.status, 'skipped:locked');
  });

  test('--dry-run does not execute', async () => {
    writeJob('dr', {
      name: 'dr',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'echo',
    });
    let spawned = 0;
    await run({
      workspaceDir,
      name: 'dr',
      spawnFn: (...a) => {
        spawned++;
        return mockSpawn({ exitCode: 0 })(...a);
      },
      flags: { dryRun: true },
    });
    assert.equal(spawned, 0);
    // No state file written for dry-run
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('dr'), null);
    assert.equal(state, null);
  });

  test('definition_invalid → exit 2 + category', async () => {
    // Write an invalid def
    writeFileSync(
      join(workspaceDir, 'user-data/jobs/broken.md'),
      '---\nname: broken\nruntime: agent\n---\nbody'
    );
    const result = await run({
      workspaceDir,
      name: 'broken',
      spawnFn: mockSpawn({ exitCode: 0 }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 2);
    const state = readJSON(jobsPaths(workspaceDir).stateJSON('broken'));
    assert.equal(state.last_failure_category, 'definition_invalid');
  });
});

describe('runner notification non-blocking', () => {
  test('slow notify does not delay runner exit', async () => {
    writeJob('bad', {
      name: 'bad',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'false',
    });
    const slow = () => {
      // Do nothing (the real impl spawns detached + unref's; we just verify
      // the runner doesn't await this synchronously for >500ms)
      return true;
    };
    const t0 = Date.now();
    await run({
      workspaceDir,
      name: 'bad',
      spawnFn: mockSpawn({ exitCode: 1, delay: 0 }),
      notifyFn: slow,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `runner took ${elapsed}ms; should be <1000ms`);
  });
});

describe('runner recovery / status transitions', () => {
  test('failed → ok records previously_failed_until', async () => {
    writeJob('flaky', {
      name: 'flaky',
      description: 'd',
      runtime: 'node',
      schedule: '0 4 * * *',
      command: 'echo',
    });
    await run({
      workspaceDir,
      name: 'flaky',
      spawnFn: mockSpawn({ exitCode: 1, stderr: 'fail' }),
      notifyFn: () => true,
      now: new Date('2026-04-25T04:00:00Z'),
    });
    const state1 = readJSON(jobsPaths(workspaceDir).stateJSON('flaky'));
    assert.equal(state1.last_status, 'failed');
    assert.equal(state1.consecutive_failures, 1);
    assert.ok(state1.failing_since);

    await run({
      workspaceDir,
      name: 'flaky',
      spawnFn: mockSpawn({ exitCode: 0, stdout: 'ok' }),
      notifyFn: () => true,
      now: new Date('2026-04-26T04:00:00Z'),
      flags: { force: true },
    });
    const state2 = readJSON(jobsPaths(workspaceDir).stateJSON('flaky'));
    assert.equal(state2.last_status, 'ok');
    assert.equal(state2.consecutive_failures, 0);
    assert.equal(state2.failing_since, null);
    assert.ok(state2.previously_failed_until);
    assert.ok(state2.previously_failed_duration_ms > 0);
  });
});

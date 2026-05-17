import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discretionHandler } from '../../cognition/discretion/handler.js';

function makeHarness() {
  const exitCalls = [];
  const stderrLines = [];
  return {
    exit: (code) => exitCalls.push(code),
    stderr: (line) => stderrLines.push(line),
    exitCalls,
    stderrLines,
  };
}

test('discretionHandler: blocks on tool_input.command shape', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { tool_name: 'Bash', tool_input: { command: 'cat user-data/secrets/.env' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.equal(h.stderrLines.length, 1);
  assert.match(h.stderrLines[0], /^Robin: blocked Bash — secrets-read: /);
});

test('discretionHandler: blocks on bare command shape', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { command: 'rm -rf /tmp/foo' },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.equal(h.stderrLines.length, 1);
  assert.match(h.stderrLines[0], /destructive-rm/);
});

test('discretionHandler: blocks on input.command shape', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { input: { command: 'env | grep TOKEN' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('discretionHandler: clean command does not exit or write stderr', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: missing command (fail-soft) does not exit', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { tool_name: 'Bash', tool_input: {} },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: empty stdin (fail-soft)', async () => {
  const h = makeHarness();
  await discretionHandler({ stdin: {}, exit: h.exit, stderr: h.stderr });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: undefined stdin (fail-soft)', async () => {
  const h = makeHarness();
  await discretionHandler({ stdin: undefined, exit: h.exit, stderr: h.stderr });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: tool_input.command takes priority over input.command', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: {
      tool_input: { command: 'ls -la' }, // clean — wins
      input: { command: 'rm -rf /' }, // would block, but ignored
    },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: db-direct-access blocks surreal sql against user-data/db/', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: {
      tool_input: {
        command: 'surreal sql --conn rocksdb://user-data/db/main',
      },
    },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /db-direct-access/);
});

test('discretionHandler: stderr writer is invoked exactly once on block', async () => {
  const h = makeHarness();
  await discretionHandler({
    stdin: { tool_input: { command: 'eval "$x"' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.equal(h.stderrLines.length, 1);
  assert.equal(h.exitCalls.length, 1);
});

// The bypass list is read from ROBIN_BYPASS_PROJECT_PATHS on every hook
// fire. Each bypass test scopes the env var locally and restores it so
// concurrent tests in the suite don't leak state.
function withBypassEnv(value, fn) {
  const prior = process.env.ROBIN_BYPASS_PROJECT_PATHS;
  process.env.ROBIN_BYPASS_PROJECT_PATHS = value;
  return Promise.resolve(fn()).finally(() => {
    if (prior === undefined) delete process.env.ROBIN_BYPASS_PROJECT_PATHS;
    else process.env.ROBIN_BYPASS_PROJECT_PATHS = prior;
  });
}

test('discretionHandler: bypassed cwd skips env-dump rule', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a', () =>
    discretionHandler({
      stdin: {
        cwd: '/tmp/robin-bypass-test-a',
        tool_input: { command: 'vercel env pull .env.local --yes' },
      },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: bypassed cwd subdirectory also skips rules', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a', () =>
    discretionHandler({
      stdin: {
        cwd: '/tmp/robin-bypass-test-a/apps/web',
        tool_input: { command: 'env | grep TOKEN' },
      },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('discretionHandler: sibling path with shared prefix still blocked (no prefix-attack)', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a', () =>
    discretionHandler({
      stdin: {
        cwd: '/tmp/robin-bypass-test-a-archive',
        tool_input: { command: 'env' },
      },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('discretionHandler: missing cwd does NOT bypass (fail-closed)', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a', () =>
    discretionHandler({
      stdin: { tool_input: { command: 'env' } },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('discretionHandler: non-bypassed cwd still applies rules', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a', () =>
    discretionHandler({
      stdin: {
        cwd: '/tmp/robin-other-project',
        tool_input: { command: 'env' },
      },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('discretionHandler: empty ROBIN_BYPASS_PROJECT_PATHS means no bypass (default for npm installs)', async () => {
  const h = makeHarness();
  await withBypassEnv('', () =>
    discretionHandler({
      stdin: { cwd: '/tmp/robin-bypass-test-a', tool_input: { command: 'env' } },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('discretionHandler: colon-separated multi-path bypass', async () => {
  const h = makeHarness();
  await withBypassEnv('/tmp/robin-bypass-test-a:/tmp/robin-bypass-test-b', () =>
    discretionHandler({
      stdin: { cwd: '/tmp/robin-bypass-test-b/sub', tool_input: { command: 'env' } },
      exit: h.exit,
      stderr: h.stderr,
    }),
  );
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashPolicyHandler } from '../../src/hooks/handlers/bash-policy.js';

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

test('bashPolicyHandler: blocks on tool_input.command shape', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { tool_name: 'Bash', tool_input: { command: 'cat user-data/secrets/.env' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.equal(h.stderrLines.length, 1);
  assert.match(h.stderrLines[0], /^Robin: blocked Bash — secrets-read: /);
});

test('bashPolicyHandler: blocks on bare command shape', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { command: 'rm -rf /tmp/foo' },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.equal(h.stderrLines.length, 1);
  assert.match(h.stderrLines[0], /destructive-rm/);
});

test('bashPolicyHandler: blocks on input.command shape', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { input: { command: 'env | grep TOKEN' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, [2]);
  assert.match(h.stderrLines[0], /env-dump/);
});

test('bashPolicyHandler: clean command does not exit or write stderr', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('bashPolicyHandler: missing command (fail-soft) does not exit', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { tool_name: 'Bash', tool_input: {} },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('bashPolicyHandler: empty stdin (fail-soft)', async () => {
  const h = makeHarness();
  await bashPolicyHandler({ stdin: {}, exit: h.exit, stderr: h.stderr });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('bashPolicyHandler: undefined stdin (fail-soft)', async () => {
  const h = makeHarness();
  await bashPolicyHandler({ stdin: undefined, exit: h.exit, stderr: h.stderr });
  assert.deepEqual(h.exitCalls, []);
  assert.deepEqual(h.stderrLines, []);
});

test('bashPolicyHandler: tool_input.command takes priority over input.command', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
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

test('bashPolicyHandler: db-direct-access blocks surreal sql against user-data/db/', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
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

test('bashPolicyHandler: stderr writer is invoked exactly once on block', async () => {
  const h = makeHarness();
  await bashPolicyHandler({
    stdin: { tool_input: { command: 'eval "$x"' } },
    exit: h.exit,
    stderr: h.stderr,
  });
  assert.equal(h.stderrLines.length, 1);
  assert.equal(h.exitCalls.length, 1);
});

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createClaudeCodeAdapter } from '../../src/hosts/claude-code.js';

function fakeSpawnFactory({ stdout = '', exitCode = 0 } = {}) {
  let capturedStdin = '';
  const fn = mock.fn(() => {
    return {
      stdout: {
        on: (event, cb) => {
          if (event === 'data') setImmediate(() => cb(Buffer.from(stdout)));
        },
      },
      stderr: { on: () => {} },
      stdin: {
        write: (s) => {
          capturedStdin += s.toString();
        },
        end: () => {},
      },
      on: (event, cb) => {
        if (event === 'exit') setImmediate(() => cb(exitCode));
      },
    };
  });
  fn.getCapturedStdin = () => capturedStdin;
  return fn;
}

test('Claude adapter forwards cache_control on system messages', async () => {
  const stdout = JSON.stringify({ content: 'ok', usage: { input_tokens: 0, output_tokens: 0 } });
  const fakeSpawn = fakeSpawnFactory({ stdout });
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });

  await adapter.invokeLLM([{ role: 'user', content: 'q' }], {
    system: [
      { role: 'system', content: 'sys-prompt-1', cache_control: { type: 'ephemeral' } },
      { role: 'system', content: 'sys-prompt-2' }, // no cache_control on this one
    ],
  });

  const payload = JSON.parse(fakeSpawn.getCapturedStdin());
  assert.equal(payload.system.length, 2);
  assert.deepEqual(payload.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(payload.system[1].cache_control, undefined);
});

test('Claude adapter omits system field cleanly when no system messages', async () => {
  const stdout = JSON.stringify({ content: 'ok', usage: { input_tokens: 0, output_tokens: 0 } });
  const fakeSpawn = fakeSpawnFactory({ stdout });
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });

  await adapter.invokeLLM([{ role: 'user', content: 'q' }], { tier: 'fast' });

  const payload = JSON.parse(fakeSpawn.getCapturedStdin());
  assert.deepEqual(payload.system, []);
});

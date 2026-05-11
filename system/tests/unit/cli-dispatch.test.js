import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchFor } from '../../runtime/cli/index.js';

test('leaf dispatch invokes the right fn with argv.slice(N)', async () => {
  const calls = [];
  const node = {
    install: {
      fn: (argv) => calls.push({ cmd: 'install', argv }),
    },
  };
  await dispatchFor(node, ['install', '--foo']);
  assert.deepEqual(calls, [{ cmd: 'install', argv: ['--foo'] }]);
});

test('group with no subcommand prints usage and exits 1', async () => {
  const origExit = process.exit;
  const origErr = console.error;
  const errs = [];
  let exited = null;
  process.exit = (code) => {
    exited = code;
    throw new Error('__exit__');
  };
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const node = {
      mcp: { subcommands: { start: { fn: () => {} }, stop: { fn: () => {} } } },
    };
    await assert.rejects(() => dispatchFor(node, ['mcp']), /__exit__/);
    assert.equal(exited, 1);
    assert.ok(
      errs.some((e) => e.includes('<start|stop>')),
      `expected usage line, got: ${errs.join('|')}`,
    );
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
});

test('recursive group dispatch (integrations discord register-commands)', async () => {
  const calls = [];
  const node = {
    integrations: {
      subcommands: {
        discord: {
          subcommands: {
            'register-commands': { fn: (argv) => calls.push(argv) },
          },
        },
      },
    },
  };
  await dispatchFor(node, ['integrations', 'discord', 'register-commands', '--force']);
  assert.deepEqual(calls, [['--force']]);
});

test('unknown command exits 1', async () => {
  const origExit = process.exit;
  const origErr = console.error;
  let exited = null;
  process.exit = (code) => {
    exited = code;
    throw new Error('__exit__');
  };
  console.error = () => {};
  try {
    await assert.rejects(() => dispatchFor({}, ['nope']), /__exit__/);
    assert.equal(exited, 1);
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startJobHotReload } from '../../runtime/daemon/job-hot-reload.js';

function makeDir() {
  const dir = join(
    tmpdir(),
    `robin-hot-reload-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function wait(ms) {
  return new Promise((r) => {
    setTimeout(r, ms).unref?.();
  });
}

test('writes to a .js file trigger one debounced signalSelf', async () => {
  const dir = makeDir();
  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 80,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    writeFileSync(join(dir, 'a.js'), '// edit 1');
    await wait(20);
    writeFileSync(join(dir, 'a.js'), '// edit 2');
    await wait(20);
    writeFileSync(join(dir, 'a.js'), '// edit 3');
    await wait(200);
    assert.equal(calls, 1, 'three rapid edits should coalesce to one signal');
  } finally {
    w.stop();
  }
});

test('non-.js changes are ignored', async () => {
  const dir = makeDir();
  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 50,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    writeFileSync(join(dir, 'README.md'), 'hello');
    writeFileSync(join(dir, 'config.json'), '{}');
    await wait(150);
    assert.equal(calls, 0, 'md/json edits should not fire the watcher');
  } finally {
    w.stop();
  }
});

test('test files are ignored so test edits do not bounce the daemon', async () => {
  const dir = makeDir();
  mkdirSync(join(dir, 'tests'), { recursive: true });
  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 50,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    writeFileSync(join(dir, 'tests', 'foo.test.js'), '// test');
    writeFileSync(join(dir, 'foo.test.js'), '// test');
    await wait(150);
    assert.equal(calls, 0);
  } finally {
    w.stop();
  }
});

test('stop() prevents further signals from queued events', async () => {
  const dir = makeDir();
  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 80,
    signalSelf: () => calls++,
    log: () => {},
  });
  writeFileSync(join(dir, 'a.js'), '// edit');
  await wait(20);
  w.stop();
  await wait(200);
  assert.equal(calls, 0, 'stop() must cancel the pending debounce timer');
});

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

test('phantom fsevents on an unchanged file do not trigger a restart', async () => {
  // macOS fsevents fires `change` events for Spotlight indexing, atime
  // updates, etc. The watcher must compare mtimes and only signal when the
  // file actually changed. Without this gate, a single phantom event tears
  // down in-flight syncs every ~100ms (the lunch_money / gmail first-sync
  // mid-write regression).
  const { utimesSync } = await import('node:fs');
  const dir = makeDir();
  // Seed the file BEFORE the watcher starts and pin its mtime to a fixed
  // value. The watcher's startup scan will record this mtime as the
  // baseline. If a later fsevent fires and mtime is unchanged, we must
  // not signal.
  const pinned = new Date('2026-01-01T00:00:00.000Z');
  writeFileSync(join(dir, 'stable.js'), '// initial content');
  utimesSync(join(dir, 'stable.js'), pinned, pinned);

  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 40,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    // Re-stamp with the SAME mtime — simulating an atime-only or
    // Spotlight-driven phantom fsevent. The mtime field is unchanged.
    await wait(60);
    utimesSync(join(dir, 'stable.js'), new Date(), pinned);
    await wait(200);
    assert.equal(calls, 0, 'unchanged mtime should not trigger a restart');

    // Real content edit → mtime advances → must fire exactly once.
    writeFileSync(join(dir, 'stable.js'), '// real new content');
    await wait(200);
    assert.equal(calls, 1, 'real edit should fire one restart');
  } finally {
    w.stop();
  }
});

test('new files (not in the startup scan) trigger a restart on first write', async () => {
  // Counterpart to the phantom-event guard: when user creates a brand-new
  // .js file post-startup, the first event must fire so the daemon picks
  // up the new module.
  const dir = makeDir();
  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 40,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    writeFileSync(join(dir, 'brand-new.js'), '// new file');
    await wait(200);
    assert.equal(calls, 1, 'a new file appearing post-startup must fire');
  } finally {
    w.stop();
  }
});

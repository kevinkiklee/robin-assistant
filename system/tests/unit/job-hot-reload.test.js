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

test('touch / git checkout that advances mtime but not content does not fire', async () => {
  // Counterpart to the phantom-mtime guard: `touch`, `git checkout` on the
  // same branch, and rsync-style refreshes advance mtime without changing
  // bytes. The watcher must hash the file to avoid bouncing the daemon on
  // those events. Without this gate, a concurrent agent's git operations
  // (or a benign nightly cleanup) bounce the daemon mid-sync.
  const { utimesSync } = await import('node:fs');
  const dir = makeDir();
  const content = '// stable content — unchanged across touches';
  const file = join(dir, 'touched.js');
  writeFileSync(file, content);
  // Pin to deep past so any subsequent mtime advance reliably moves forward.
  const past = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(file, past, past);

  let calls = 0;
  const w = startJobHotReload({
    paths: [dir],
    debounceMs: 40,
    signalSelf: () => calls++,
    log: () => {},
  });
  try {
    await wait(60);
    // Advance mtime to "now" without changing bytes — canonical `touch`.
    const now = new Date();
    utimesSync(file, now, now);
    await wait(200);
    assert.equal(calls, 0, 'touch without content change must not fire');

    // Now a real content edit on the same file fires exactly once.
    // Push mtime slightly into the future so writeFileSync's own mtime
    // (which is current time, identical to `now` above) reliably advances
    // past the recorded baseline.
    writeFileSync(file, '// genuinely new content');
    utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    await wait(200);
    assert.equal(calls, 1, 'real edit after a no-op touch still fires once');
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

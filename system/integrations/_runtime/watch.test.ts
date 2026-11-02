import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { watch } from 'chokidar';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { watchIntegrations } from './watch.ts';

class FakeWatcher extends EventEmitter {
  closes = 0;
  async close(): Promise<void> {
    this.closes++;
  }
}

function harness(retryMs: number) {
  const made: FakeWatcher[] = [];
  const fakeWatch = (() => {
    const w = new FakeWatcher();
    made.push(w);
    return w;
  }) as unknown as typeof watch;
  const handle = watchIntegrations({} as Daemon, {} as RobinDb, () => null, ['/nowhere'], {
    watch: fakeWatch,
    retryMs,
  });
  return { made, handle };
}

const emfile = () =>
  Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });

test('watchIntegrations: a watcher error (EMFILE) is contained, not thrown into the daemon', async () => {
  const { made, handle } = harness(60_000);
  // An EventEmitter with no 'error' listener throws on emit; this must not.
  assert.doesNotThrow(() => made[0].emit('error', emfile()));
  assert.doesNotThrow(() => made[0].emit('error', emfile()));
  await sleep(0);
  assert.equal(made[0].closes, 1, 'stops the failed watcher once, however many errors follow');
  await handle.close();
});

test('watchIntegrations: retries after the back-off, and keeps retrying while it fails', async () => {
  const { made, handle } = harness(20);
  made[0].emit('error', emfile());
  await sleep(60);
  assert.equal(made.length, 2, 'a fresh watcher after the back-off');
  made[1].emit('error', emfile());
  await sleep(60);
  assert.equal(made.length, 3, 'still retrying');
  await handle.close();
  assert.equal(made[2].closes, 1, 'close() stops the live watcher');
});

test('watchIntegrations: close() cancels a pending retry', async () => {
  const { made, handle } = harness(20);
  made[0].emit('error', emfile());
  await handle.close();
  await sleep(60);
  assert.equal(made.length, 1, 'no watcher is created after close');
});

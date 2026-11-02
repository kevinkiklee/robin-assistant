import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
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

test('watchIntegrations: a watcher error (EMFILE) is contained, not thrown into the daemon', async () => {
  const fake = new FakeWatcher();
  const handle = watchIntegrations({} as Daemon, {} as RobinDb, () => null, ['/nowhere'], {
    watch: (() => fake) as unknown as typeof watch,
  });
  const emfile = Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
  // An EventEmitter with no 'error' listener throws on emit; this must not.
  assert.doesNotThrow(() => fake.emit('error', emfile));
  assert.doesNotThrow(() => fake.emit('error', emfile));
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.closes, 1, 'stops watching once, however many errors follow');
  await handle.close();
});

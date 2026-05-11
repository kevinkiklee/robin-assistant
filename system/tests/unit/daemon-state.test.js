import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearDaemonState, readDaemonState, writeDaemonState } from '../../config/daemon-state.js';

test('writeDaemonState + readDaemonState round-trip', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state-'));
  const path = join(tmp, '.daemon.state');
  const data = {
    port: 12345,
    pid: process.pid,
    version: '6.0.0-alpha.2',
    started_at: new Date().toISOString(),
  };
  await writeDaemonState(path, data);
  const read = await readDaemonState(path);
  assert.deepEqual(read, data);
  rmSync(tmp, { recursive: true });
});

test('readDaemonState returns null when file missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state2-'));
  const path = join(tmp, '.daemon.state');
  const r = await readDaemonState(path);
  assert.equal(r, null);
  rmSync(tmp, { recursive: true });
});

test('clearDaemonState removes the file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-daemon-state3-'));
  const path = join(tmp, '.daemon.state');
  await writeDaemonState(path, {
    port: 1,
    pid: 1,
    version: 'x',
    started_at: new Date().toISOString(),
  });
  await clearDaemonState(path);
  const r = await readDaemonState(path);
  assert.equal(r, null);
  rmSync(tmp, { recursive: true });
});

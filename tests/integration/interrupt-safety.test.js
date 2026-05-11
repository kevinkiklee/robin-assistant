import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHome, readMarker, writePointer } from '../../src/runtime/data-store.js';

test('interrupt between ensureHome and writePointer: re-running both is idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-interrupt-'));
  process.env.ROBIN_HOME = home;
  try {
    // First call: creates dirs + marker.
    await ensureHome();
    const firstMarker = readMarker();
    assert.strictEqual(firstMarker.version, 1);

    // Simulate "interrupted after ensureHome but before writePointer":
    // call ensureHome a second time — marker must remain identical.
    await ensureHome();
    const secondMarker = readMarker();
    assert.deepStrictEqual(firstMarker, secondMarker, 'marker is unchanged by repeated ensureHome');

    // writePointer only touches the pointer file, not the marker.
    writePointer({ home, installedBy: 'test' });
    const thirdMarker = readMarker();
    assert.deepStrictEqual(firstMarker, thirdMarker, 'marker is unchanged by writePointer');
  } finally {
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

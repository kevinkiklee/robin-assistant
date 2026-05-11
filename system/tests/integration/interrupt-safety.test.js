import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHome, readMarker, writePointer } from '../../config/data-store.js';

test('interrupt between ensureHome and writePointer: re-running both is idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-interrupt-'));
  const pointerDir = mkdtempSync(join(tmpdir(), 'robin-ptr-'));
  const prevHome = process.env.ROBIN_HOME;
  const prevPtr = process.env.ROBIN_POINTER_PATH;
  process.env.ROBIN_HOME = home;
  process.env.ROBIN_POINTER_PATH = join(pointerDir, '.robin-home');
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
    if (prevHome) process.env.ROBIN_HOME = prevHome;
    else delete process.env.ROBIN_HOME;
    if (prevPtr) process.env.ROBIN_POINTER_PATH = prevPtr;
    else delete process.env.ROBIN_POINTER_PATH;
    rmSync(home, { recursive: true, force: true });
    rmSync(pointerDir, { recursive: true, force: true });
  }
});

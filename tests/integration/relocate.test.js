import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { relocate } from '../../src/cli/commands/install.js';
import {
  ensureHome,
  readHostIntegrations,
  readPointer,
  recordHostTouchpoint,
  writePointer,
} from '../../src/runtime/data-store.js';

test('relocate: moves home + refreshes expectedHome on plist/systemd entries', async () => {
  const A = mkdtempSync(join(tmpdir(), 'robin-A-'));
  const Bparent = mkdtempSync(join(tmpdir(), 'robin-B-parent-'));
  const B = join(Bparent, 'Robin');
  const fakePlistDir = mkdtempSync(join(tmpdir(), 'fake-plist-'));
  const fakePlist = join(fakePlistDir, 'io.robin-assistant.mcp.plist');
  writeFileSync(fakePlist, '<plist/>');
  const pointerDir = mkdtempSync(join(tmpdir(), 'robin-ptr-'));
  const prevHome = process.env.ROBIN_HOME;
  const prevPtr = process.env.ROBIN_POINTER_PATH;
  process.env.ROBIN_HOME = A;
  process.env.ROBIN_POINTER_PATH = join(pointerDir, '.robin-home');
  try {
    await ensureHome();
    writePointer({ home: A, installedBy: 'test' });
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: fakePlist, expectedHome: A, label: 'io.robin-assistant.mcp' },
      () => {},
    );
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    delete process.env.ROBIN_HOME;
    await relocate({
      target: B,
      mode: 'move',
      stopDaemon: async () => {},
      rewriteLaunchd: async () => {},
      rewriteSystemd: async () => {},
    });
    assert.strictEqual(existsSync(A), false);
    assert.ok(existsSync(B));
    assert.strictEqual(readPointer().home, B);
    process.env.ROBIN_HOME = B;
    const m = await readHostIntegrations();
    const plist = m.entries.find((e) => e.kind === 'launchd-plist');
    assert.strictEqual(plist.expectedHome, B);
  } finally {
    if (prevHome) process.env.ROBIN_HOME = prevHome;
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not set undefined
    else delete process.env.ROBIN_HOME;
    if (prevPtr) process.env.ROBIN_POINTER_PATH = prevPtr;
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not set undefined
    else delete process.env.ROBIN_POINTER_PATH;
    rmSync(Bparent, { recursive: true, force: true });
    rmSync(fakePlistDir, { recursive: true, force: true });
    rmSync(pointerDir, { recursive: true, force: true });
  }
});

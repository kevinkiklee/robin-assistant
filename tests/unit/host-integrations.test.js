import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  paths,
  readHostIntegrations,
  recordHostTouchpoint,
  forgetHostTouchpoint,
} from '../../src/runtime/data-store.js';

function withHome(t, fn) {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  });
}

test('recordHostTouchpoint appends entry and runs writeFn first', async () => {
  await withHome(test, async (home) => {
    await ensureHome();
    const targetFile = join(home, 'fake-host-file.json');
    let writeFnCalled = false;
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: targetFile, owned: [{ phase: 'PreToolUse' }] },
      () => {
        writeFnCalled = true;
        writeFileSync(targetFile, '{"hooks": "fake"}');
      },
    );
    assert.strictEqual(writeFnCalled, true);
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].kind, 'claude-hooks');
    assert.strictEqual(mf.entries[0].path, targetFile);
    assert.deepStrictEqual(mf.entries[0].owned, [{ phase: 'PreToolUse' }]);
  });
});

test('recordHostTouchpoint replaces entry by (kind, path)', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: '/x', owned: [{ phase: 'A' }] },
      () => {},
    );
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: '/x', owned: [{ phase: 'B' }] },
      () => {},
    );
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.deepStrictEqual(mf.entries[0].owned, [{ phase: 'B' }]);
  });
});

test('recordHostTouchpoint: writeFn throw leaves manifest untouched', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint({ kind: 'k1', path: '/p' }, () => {});
    await assert.rejects(
      () =>
        recordHostTouchpoint({ kind: 'k2', path: '/q' }, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].kind, 'k1');
  });
});

test('forgetHostTouchpoint removes matching entry', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint({ kind: 'k', path: '/p1' }, () => {});
    await recordHostTouchpoint({ kind: 'k', path: '/p2' }, () => {});
    const r = await forgetHostTouchpoint({ kind: 'k', path: '/p1' });
    assert.strictEqual(r.removed, 1);
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].path, '/p2');
  });
});

test('forgetHostTouchpoint is idempotent', async () => {
  await withHome(test, async () => {
    await ensureHome();
    const r = await forgetHostTouchpoint({ kind: 'k', path: '/missing' });
    assert.strictEqual(r.removed, 0);
  });
});

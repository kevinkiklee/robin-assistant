import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureHome,
  pointerExists,
  readHostIntegrations,
  readMarker,
  readPointer,
  recordHostTouchpoint,
  writePointer,
} from '../../src/runtime/data-store.js';

test('Kevin rollout: legacy v2 layout with installed-hooks.json migrates cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-kevin-'));
  const fakePlistDir = mkdtempSync(join(tmpdir(), 'fake-plist-'));
  const fakePlist = join(fakePlistDir, 'fake-plist');
  const pointerDir = mkdtempSync(join(tmpdir(), 'robin-ptr-'));
  const prevHome = process.env.ROBIN_HOME;
  const prevPtr = process.env.ROBIN_POINTER_PATH;
  process.env.ROBIN_HOME = home;
  process.env.ROBIN_POINTER_PATH = join(pointerDir, '.robin-home');
  try {
    // Pre-seed legacy state.
    mkdirSync(join(home, 'db'), { recursive: true });
    mkdirSync(join(home, 'secrets'), { recursive: true });
    writeFileSync(join(home, 'db', 'CURRENT'), 'rocksdb');
    writeFileSync(join(home, 'secrets', '.env'), 'GEMINI_API_KEY=abc', { mode: 0o600 });
    writeFileSync(
      join(home, 'installed-hooks.json'),
      JSON.stringify({
        claude: [
          { phase: 'PreToolUse', matcher: 'Bash', command: '/abs/bin/robin-hook.sh bash-policy' },
        ],
        gemini: [{ phase: 'Stop', command: '/abs/bin/robin-hook.sh stop' }],
      }),
    );

    await ensureHome();
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: fakePlist, expectedHome: home, label: 'l' },
      () => writeFileSync(fakePlist, '<plist/>'),
    );
    writePointer({ home, installedBy: 'kevin-rollout-test' });

    const marker = readMarker();
    assert.strictEqual(marker.version, 1);
    assert.ok(pointerExists());
    assert.strictEqual(readPointer().home, home);
    assert.strictEqual(existsSync(join(home, 'installed-hooks.json')), false);
    const m = await readHostIntegrations();
    const kinds = m.entries.map((e) => e.kind).sort();
    assert.deepStrictEqual(kinds, ['claude-hooks', 'gemini-hooks', 'launchd-plist']);
    assert.strictEqual(statSync(join(home, 'secrets', '.env')).mode & 0o777, 0o600);
  } finally {
    if (prevHome) process.env.ROBIN_HOME = prevHome;
    else delete process.env.ROBIN_HOME;
    if (prevPtr) process.env.ROBIN_POINTER_PATH = prevPtr;
    else delete process.env.ROBIN_POINTER_PATH;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakePlistDir, { recursive: true, force: true });
    rmSync(pointerDir, { recursive: true, force: true });
  }
});

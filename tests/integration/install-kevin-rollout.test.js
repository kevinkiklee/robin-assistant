import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  deletePointer,
  ensureHome,
  packageRootDir,
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
  process.env.ROBIN_HOME = home;
  // Stash any existing .robin-home pointer so this test does not corrupt it.
  const pointerPath = join(packageRootDir(), '.robin-home');
  const stash = `${pointerPath}.stash-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const hadPointer = existsSync(pointerPath);
  if (hadPointer) renameSync(pointerPath, stash);
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
    // biome-ignore lint/performance/noDelete: env vars must be deleted, not assigned undefined
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakePlistDir, { recursive: true, force: true });
    // Restore the original pointer (or remove the test-written one).
    if (existsSync(pointerPath)) rmSync(pointerPath, { force: true });
    if (hadPointer) renameSync(stash, pointerPath);
  }
});

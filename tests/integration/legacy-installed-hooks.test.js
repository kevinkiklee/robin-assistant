import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  readHostIntegrations,
  recordHostTouchpoint,
} from '../../src/runtime/data-store.js';

test('legacy installed-hooks.json is migrated on first manifest write and then deleted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const legacyPath = join(home, 'installed-hooks.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        claude: [
          {
            phase: 'PreToolUse',
            matcher: 'Bash',
            command: '/abs/bin/robin-hook.sh bash-policy',
          },
        ],
        gemini: [{ phase: 'Stop', command: '/abs/bin/robin-hook.sh stop' }],
      }),
    );
    const before = await readHostIntegrations();
    assert.strictEqual(before.entries.length, 2);
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: '/x', expectedHome: home, label: 'l' },
      () => {},
    );
    assert.strictEqual(existsSync(legacyPath), false, 'legacy file should be deleted after first write');
    const after = await readHostIntegrations();
    assert.strictEqual(after.entries.length, 3);
    const kinds = after.entries.map((e) => e.kind).sort();
    assert.deepStrictEqual(kinds, ['claude-hooks', 'gemini-hooks', 'launchd-plist']);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

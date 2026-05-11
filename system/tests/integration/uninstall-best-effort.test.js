import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureHome, readHostIntegrations, recordHostTouchpoint } from '../../config/data-store.js';
import { uninstall } from '../../runtime/cli/commands/uninstall.js';

test('uninstall: best-effort completes even with one malformed host file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const fakeClaudeDir = mkdtempSync(join(tmpdir(), 'robin-claude-'));
  const fakeSettings = join(fakeClaudeDir, 'settings.json');
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    writeFileSync(fakeSettings, 'not-json{{{'); // malformed
    await recordHostTouchpoint({ kind: 'claude-hooks', path: fakeSettings, owned: [] }, () => {});
    await uninstall([], {
      interactive: false,
      prompt: async () => 'k',
      stopDaemon: async () => {},
    });
    const after = await readHostIntegrations();
    // After best-effort uninstall, the malformed entry should have been forgotten.
    assert.strictEqual(after.entries.length, 0);
  } finally {
    process.env.ROBIN_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeClaudeDir, { recursive: true, force: true });
  }
});

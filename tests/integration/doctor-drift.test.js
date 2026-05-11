import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { doctorData } from '../../src/cli/commands/doctor.js';
import { ensureHome, recordHostTouchpoint, writePointer } from '../../src/runtime/data-store.js';

test('doctorData: reports drift when a host file no longer contains a recorded command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  process.env.ROBIN_HOME = home;
  const fakeSettings = join(home, 'fake-claude-settings.json');
  try {
    await ensureHome();
    writePointer({ home, installedBy: 'test' });
    writeFileSync(fakeSettings, JSON.stringify({ hooks: { PreToolUse: [] } }));
    await recordHostTouchpoint(
      {
        kind: 'claude-hooks',
        path: fakeSettings,
        owned: [{ phase: 'PreToolUse', command: '/abs/bin/robin-hook.sh bash-policy' }],
      },
      () => {},
    );
    const report = await doctorData();
    const drift = report.drift.find((d) => d.path === fakeSettings);
    assert.ok(drift, 'should report drift for the missing command');
    assert.match(drift.reason, /command not present/);
  } finally {
    process.env.ROBIN_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { PowerAutoMonitor } from './monitor.ts';

function freshUserData(thresholdPct: number) {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pwr-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    join(dir, 'config', 'policies.yaml'),
    `power:
  state: active
  auto:
    on_battery_below_pct: ${thresholdPct}
    auto_resume_on_ac: true
capture:
  enabled: true
network:
  mode: online
`,
  );
  process.env.ROBIN_USER_DATA_DIR = dir;
  return dir;
}

test('power-auto: pauses when battery low and unplugged', async () => {
  const dir = freshUserData(30);
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: false, percent: 20 }),
  });
  await m.tick();
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'paused');
});

test('power-auto: does NOT pause when plugged in', async () => {
  const dir = freshUserData(30);
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: true, percent: 20 }),
  });
  await m.tick();
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'active');
});

test('power-auto: auto-resumes when AC reconnected after auto-pause', async () => {
  const dir = freshUserData(30);
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: false, percent: 20 }),
  });
  await m.tick(); // pauses
  // Simulate AC connect by swapping the readBattery override on the private opts field.
  // biome-ignore lint/suspicious/noExplicitAny: test reaches into private opts to swap the battery reader
  (m as any).opts.readBattery = async () => ({ available: true, charging: true, percent: 22 });
  await m.tick(); // should resume
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'active');
});

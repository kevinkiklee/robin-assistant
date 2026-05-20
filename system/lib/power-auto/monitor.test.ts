import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  // Simulate AC connect
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).opts.readBattery = async () => ({ available: true, charging: true, percent: 22 });
  await m.tick(); // should resume
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'active');
});

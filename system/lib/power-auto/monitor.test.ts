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

// Writes a policies.yaml with an explicit pre-existing pause + provenance, simulating
// state persisted by a *previous* daemon process. Each test then uses a FRESH monitor
// (no in-memory carryover) — this is the exact restart scenario the old in-memory
// `lastAuto` flag could not handle, which stranded Robin paused for ~22h.
function userDataPaused(setBy: 'auto' | 'user', opts: { threshold?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pwr-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  const thresholdLine =
    opts.threshold === undefined ? '' : `    on_battery_below_pct: ${opts.threshold}\n`;
  writeFileSync(
    join(dir, 'config', 'policies.yaml'),
    `power:
  state: paused
  set_by: ${setBy}
  since: '2026-05-28T11:00:00.000Z'
  auto:
${thresholdLine}    auto_resume_on_ac: true
capture:
  enabled: true
network:
  mode: online
`,
  );
  process.env.ROBIN_USER_DATA_DIR = dir;
  return dir;
}

test('power-auto: auto-resumes an auto-pause across a restart (fresh monitor, persisted provenance)', async () => {
  const dir = userDataPaused('auto', { threshold: 30 });
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: true, percent: 80 }),
  });
  await m.tick();
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'active');
});

test('power-auto: does NOT auto-resume a manual pause on AC', async () => {
  const dir = userDataPaused('user', { threshold: 30 });
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: true, percent: 80 }),
  });
  await m.tick();
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'paused');
});

test('power-auto: auto-resume works even without a battery threshold configured', async () => {
  const dir = userDataPaused('auto'); // no on_battery_below_pct
  const m = new PowerAutoMonitor({
    readBattery: async () => ({ available: true, charging: true, percent: 80 }),
  });
  await m.tick();
  const after = parseYaml(readFileSync(join(dir, 'config', 'policies.yaml'), 'utf8'));
  assert.equal(after.power.state, 'active');
});

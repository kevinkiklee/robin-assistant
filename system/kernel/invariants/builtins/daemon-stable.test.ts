import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { daemonStableInvariant } from './daemon-stable.ts';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const now = () => NOW;

function tmpBootsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-daemon-stable-'));
  return join(dir, 'boots.json');
}

/** ISO string `minutesAgo` minutes before NOW */
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

/** ISO string `hoursAgo` hours before NOW */
function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

test('daemon-stable: missing boots.json → ok', async () => {
  const bootsPath = join(mkdtempSync(join(tmpdir(), 'robin-stable-')), 'boots.json');
  // File does not exist — do NOT create it.
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('daemon-stable: corrupt JSON in boots.json → ok', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, 'not-json{{{');
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('daemon-stable: 2 recent boots (within 1h) → ok', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, JSON.stringify([minutesAgo(10), minutesAgo(30)]));
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('daemon-stable: exactly 3 recent boots → fires with count=3', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, JSON.stringify([minutesAgo(5), minutesAgo(20), minutesAgo(45)]));
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /3/);
  assert.ok(r.remediation, 'remediation should be present');
});

test('daemon-stable: 3 boots spread over 3 hours (only 1 within the window) → ok', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, JSON.stringify([hoursAgo(3), hoursAgo(2), minutesAgo(10)]));
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('daemon-stable: 5 boots, 4 within the last hour → fires with count=4', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([hoursAgo(5), minutesAgo(5), minutesAgo(15), minutesAgo(30), minutesAgo(50)]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /4/);
});

test('daemon-stable: boots.json contains non-array JSON → ok', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, JSON.stringify({ boots: ['2026-06-10T12:00:00.000Z'] }));
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

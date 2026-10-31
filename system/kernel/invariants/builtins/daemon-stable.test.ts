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

// --- crash-class-only storm counting (Task 4) ---
//
// Pre-existing tests above pinned "every restart counts" behavior — the
// legacy shape (bare ISO strings) still exercises that path and still fires,
// because unclassifiable entries count as crashes by design (error doctrine:
// absence of a stamp is the signal). What changes here is that *classified*
// non-crash entries (clean-shutdown, heartbeat-escalation, system-reboot) no
// longer storm-count, and the failure message now reports a per-class
// breakdown.

test('daemon-stable: stamped and system-reboot entries do not storm-count', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: minutesAgo(50), class: 'clean-shutdown' },
      { at: minutesAgo(40), class: 'clean-shutdown' },
      { at: minutesAgo(30), class: 'system-reboot' },
      { at: minutesAgo(20), class: 'heartbeat-escalation' },
    ]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  // 4 restarts, 0 crashes → quiet
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('daemon-stable: three crash-class entries within the hour fire the invariant', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: minutesAgo(30), class: 'crash' },
      { at: minutesAgo(20), class: 'crash' },
      { at: minutesAgo(10), class: 'crash' },
    ]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /crashed 3 times/);
});

test('daemon-stable: object entries with a missing/non-string class count as crash', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: minutesAgo(30) },
      { at: minutesAgo(20), class: 42 },
      { at: minutesAgo(10), class: 'crash' },
    ]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /crashed 3 times/);
});

test('daemon-stable: legacy string entries count as crashes (unclassifiable = suspicious)', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(bootsPath, JSON.stringify([minutesAgo(30), minutesAgo(20), minutesAgo(10)]));
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /crashed 3 times/);
});

test('daemon-stable: failure message reports the per-class breakdown', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: minutesAgo(50), class: 'clean-shutdown' },
      { at: minutesAgo(30), class: 'crash' },
      { at: minutesAgo(20), class: 'crash' },
      { at: minutesAgo(10), class: 'crash' },
    ]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(
    r.message ?? '',
    /daemon crashed 3 times in the last hour \(4 restarts total: .*1 clean-shutdown.*3 crash.*\)/,
  );
});

test('daemon-stable: malformed elements (null, number) are skipped, not thrown on', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      null,
      42,
      { at: minutesAgo(30), class: 'crash' },
      { at: minutesAgo(20), class: 'crash' },
      { at: minutesAgo(10), class: 'crash' },
    ]),
  );
  const inv = daemonStableInvariant({ bootsPath, now });
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /crashed 3 times/);
  assert.match(r.message ?? '', /3 restarts total/);
});

test('daemon-stable: a daily unexplained kill (3 crash boots across 7 days) fires', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: hoursAgo(24 * 6), class: 'crash' },
      { at: hoursAgo(24 * 3), class: 'clean-shutdown' },
      { at: hoursAgo(24 * 2), class: 'crash' },
      { at: hoursAgo(24), class: 'crash' },
    ]),
  );
  const r = await daemonStableInvariant({ bootsPath, now }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /3 times in 7 days/);
});

test('daemon-stable: two crashes a week, or old crashes, stay ok', async () => {
  const bootsPath = tmpBootsPath();
  writeFileSync(
    bootsPath,
    JSON.stringify([
      { at: hoursAgo(24 * 9), class: 'crash' },
      { at: hoursAgo(24 * 5), class: 'crash' },
      { at: hoursAgo(24 * 2), class: 'heartbeat-escalation' },
      { at: hoursAgo(24), class: 'crash' },
    ]),
  );
  const r = await daemonStableInvariant({ bootsPath, now }).check();
  assert.equal(r.ok, true, JSON.stringify(r));
});

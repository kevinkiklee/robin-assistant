import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type CloudRole, writeRole } from './role.ts';
import { watchdog } from './watchdog.ts';

function setup(health: boolean[], role: CloudRole | null = 'vm-primary') {
  const userData = mkdtempSync(join(tmpdir(), 'robin-wd-'));
  if (role) writeRole(userData, { role, at: '2026-01-01T00:00:00.000Z', host: 'example-vm' });
  let probes = 0;
  const sent: Array<{ title: string; message: string; silent?: boolean }> = [];
  let t = 1_000_000;
  let i = 0;
  const sleeps: number[] = [];
  return {
    userData,
    sent,
    sleeps,
    probes: () => probes,
    advance: (ms: number) => {
      t += ms;
    },
    run: () =>
      watchdog({
        userData,
        fetchHealth: async () => {
          probes++;
          return health[Math.min(i++, health.length - 1)];
        },
        notify: async (p) => {
          sent.push(p);
        },
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: () => {},
      }),
  };
}

describe('watchdog', () => {
  for (const role of [null, 'vm-dry-run', 'mac-locked'] as const) {
    it(`stays quiet when the role is ${role ?? 'absent'}, even with the daemon down`, async () => {
      const s = setup([false, false, false], role);
      assert.equal(await s.run(), 'not-primary');
      s.advance(2 * 60 * 60_000);
      assert.equal(await s.run(), 'not-primary');
      assert.equal(s.sent.length, 0);
      assert.equal(s.probes(), 0);
      assert.ok(!existsSync(join(s.userData, 'state/runtime/watchdog.json')));
    });
  }
  it('vm-primary and down still sends the loud notice', async () => {
    const s = setup([false, false], 'vm-primary');
    assert.equal(await s.run(), 'down-notified');
    assert.equal(s.sent.length, 1);
    assert.ok(!s.sent[0].silent);
  });
  it('healthy and never down is ok and silent', async () => {
    const s = setup([true]);
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 0);
  });
  it('down notifies once, then stays quiet within the hour', async () => {
    const s = setup([false, false, false, false, false, false]);
    assert.equal(await s.run(), 'down-notified');
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].title, "Robin's daemon is not answering on the VM");
    assert.ok(!s.sent[0].silent);
    s.advance(15 * 60_000);
    assert.equal(await s.run(), 'down-quiet');
    assert.equal(s.sent.length, 1);
    s.advance(50 * 60_000);
    assert.equal(await s.run(), 'down-notified');
    assert.equal(s.sent.length, 2);
  });
  it('recovery sends one silent notice', async () => {
    const s = setup([false, false, true, true]);
    await s.run();
    s.advance(60_000);
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1].title, "Robin's daemon is back");
    assert.equal(s.sent[1].silent, true);
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 2);
    const stamp = JSON.parse(readFileSync(join(s.userData, 'state/runtime/watchdog.json'), 'utf8'));
    assert.equal(stamp.down, false);
  });
  it('retries a failed probe once after 5 s before declaring down', async () => {
    const s = setup([false, true]);
    assert.equal(await s.run(), 'ok');
    assert.deepEqual(s.sleeps, [5000]);
    assert.equal(s.sent.length, 0);
  });
  it('an unwritable stamp sends nothing and does not throw', async () => {
    const s = setup([false]);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    // The stamp path is a non-empty directory: the role still reads, the rename fails.
    mkdirSync(join(s.userData, 'state/runtime/watchdog.json'), { recursive: true });
    writeFileSync(join(s.userData, 'state/runtime/watchdog.json/x'), 'a dir, not a file');
    assert.equal(await s.run(), 'down-quiet');
    assert.equal(s.sent.length, 0);
  });
  it('flapping within an hour: one loud notice, at most one recovery', async () => {
    const s = setup([false, false, true, false, false, true, true]);
    await s.run(); // down, loud
    s.advance(60_000);
    await s.run(); // up (recovery, silent)
    s.advance(60_000);
    await s.run(); // down again, within the hour
    s.advance(60_000);
    await s.run(); // up again
    const loud = s.sent.filter((p) => !p.silent);
    const quiet = s.sent.filter((p) => p.silent);
    assert.equal(loud.length, 1);
    assert.equal(quiet.length, 1);
  });
  it('first-ever outage and recovery at a small clock still notify', async () => {
    const s = setup([false, false, true]);
    assert.equal(await s.run(), 'down-notified');
    s.advance(60_000);
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1].silent, true);
  });
  it('a corrupt stamp reads as healthy-before', async () => {
    const s = setup([true]);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(s.userData, 'state/runtime'), { recursive: true });
    writeFileSync(join(s.userData, 'state/runtime/watchdog.json'), '{nope');
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 0);
  });
});

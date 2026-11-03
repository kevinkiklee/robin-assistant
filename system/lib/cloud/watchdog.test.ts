import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { watchdog } from './watchdog.ts';

function setup(health: boolean[]) {
  const userData = mkdtempSync(join(tmpdir(), 'robin-wd-'));
  const sent: Array<{ title: string; message: string; silent?: boolean }> = [];
  let t = 1_000_000;
  let i = 0;
  return {
    userData,
    sent,
    advance: (ms: number) => {
      t += ms;
    },
    run: () =>
      watchdog({
        userData,
        fetchHealth: async () => health[Math.min(i++, health.length - 1)],
        notify: async (p) => {
          sent.push(p);
        },
        now: () => t,
      }),
  };
}

describe('watchdog', () => {
  it('healthy and never down is ok and silent', async () => {
    const s = setup([true]);
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 0);
  });
  it('down notifies once, then stays quiet within the hour', async () => {
    const s = setup([false, false, false]);
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
    const s = setup([false, true, true]);
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
  it('a corrupt stamp reads as healthy-before', async () => {
    const s = setup([true]);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(s.userData, 'state/runtime'), { recursive: true });
    writeFileSync(join(s.userData, 'state/runtime/watchdog.json'), '{nope');
    assert.equal(await s.run(), 'ok');
    assert.equal(s.sent.length, 0);
  });
});

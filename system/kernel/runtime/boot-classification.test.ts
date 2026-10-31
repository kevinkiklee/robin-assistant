import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendBootEntry, classifyBoot, readBootEntries } from './boot-classification.ts';
import { writeShutdownStamp } from './shutdown-stamp.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'boot-'));

test('stamp with reason shutdown → clean-shutdown, stamp consumed', () => {
  const d = dir();
  const stampPath = join(d, 'stamp.json');
  writeShutdownStamp(stampPath, 'shutdown', 1);
  const c = classifyBoot({ stampPath, prevBootAt: null, systemBootMs: 0 });
  assert.strictEqual(c, 'clean-shutdown');
  // consumed: a second boot with no new stamp is NOT clean
  assert.strictEqual(classifyBoot({ stampPath, prevBootAt: null, systemBootMs: 0 }), 'crash');
});

test('stamp with reason heartbeat-escalation → heartbeat-escalation', () => {
  const d = dir();
  const stampPath = join(d, 'stamp.json');
  writeShutdownStamp(stampPath, 'heartbeat-escalation', 1);
  assert.strictEqual(
    classifyBoot({ stampPath, prevBootAt: null, systemBootMs: 0 }),
    'heartbeat-escalation',
  );
});

test('no stamp + OS booted after previous daemon boot → system-reboot', () => {
  const d = dir();
  const prevBootAt = '2026-08-10T01:00:00.000Z';
  const systemBootMs = Date.parse('2026-08-10T02:00:00.000Z'); // OS booted later
  const c = classifyBoot({ stampPath: join(d, 'none.json'), prevBootAt, systemBootMs });
  assert.strictEqual(c, 'system-reboot');
});

test('no stamp + OS booted before previous daemon boot → crash', () => {
  const d = dir();
  const prevBootAt = '2026-08-10T02:00:00.000Z';
  const systemBootMs = Date.parse('2026-08-10T01:00:00.000Z'); // OS up the whole time
  const c = classifyBoot({ stampPath: join(d, 'none.json'), prevBootAt, systemBootMs });
  assert.strictEqual(c, 'crash');
});

test('appendBootEntry keeps last 20 and tolerates legacy string entries', () => {
  const d = dir();
  const bootsPath = join(d, 'boots.json');
  writeFileSync(bootsPath, JSON.stringify(['2026-08-01T00:00:00.000Z'])); // legacy shape
  for (let i = 0; i < 25; i++) {
    appendBootEntry(bootsPath, {
      at: `2026-08-10T00:00:${String(i).padStart(2, '0')}.000Z`,
      class: 'crash',
    });
  }
  const entries = readBootEntries(bootsPath);
  assert.strictEqual(entries.length, 20);
  const last = entries.at(-1) as { at: string; class: string };
  assert.strictEqual(last.class, 'crash');
});

test('readBootEntries on missing/corrupt file returns []', () => {
  const d = dir();
  assert.deepStrictEqual(readBootEntries(join(d, 'none.json')), []);
  const p = join(d, 'bad.json');
  writeFileSync(p, '{not json');
  assert.deepStrictEqual(readBootEntries(p), []);
});

test('stamp with mismatched pid is consumed but does not classify clean', () => {
  const d = dir();
  const stampPath = join(d, 'stamp.json');
  writeShutdownStamp(stampPath, 'shutdown', 111);
  const c = classifyBoot({ stampPath, prevBootAt: null, systemBootMs: 0, prevPid: 222 });
  assert.strictEqual(c, 'crash'); // stamp wasn't the previous daemon's
  // and it was consumed — no second read
  assert.strictEqual(
    classifyBoot({ stampPath, prevBootAt: null, systemBootMs: 0, prevPid: 111 }),
    'crash',
  );
});

test('stamp with matching pid classifies clean; absent prevPid keeps old behavior', () => {
  const d = dir();
  const p1 = join(d, 's1.json');
  writeShutdownStamp(p1, 'shutdown', 333);
  assert.strictEqual(
    classifyBoot({ stampPath: p1, prevBootAt: null, systemBootMs: 0, prevPid: 333 }),
    'clean-shutdown',
  );
  const p2 = join(d, 's2.json');
  writeShutdownStamp(p2, 'heartbeat-escalation', 444);
  assert.strictEqual(
    classifyBoot({ stampPath: p2, prevBootAt: null, systemBootMs: 0 }), // no prevPid
    'heartbeat-escalation',
  );
});

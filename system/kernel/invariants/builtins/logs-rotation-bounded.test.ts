import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { logsRotationBoundedInvariant } from './logs-rotation-bounded.ts';

function freshLogsDir(): string {
  return mkdtempSync(join(tmpdir(), 'robin-logs-rotation-'));
}

test('logs.rotation_bounded: empty/missing dir reports ok', async () => {
  const inv = logsRotationBoundedInvariant(join(freshLogsDir(), 'nope'));
  assert.equal((await inv.check()).ok, true);
});

test('logs.rotation_bounded: flags only oversized .log files', async () => {
  const dir = freshLogsDir();
  writeFileSync(join(dir, 'big.log'), 'x'.repeat(2000));
  writeFileSync(join(dir, 'small.log'), 'y'.repeat(100));
  writeFileSync(join(dir, 'big.txt'), 'z'.repeat(5000)); // not a .log — ignored
  const inv = logsRotationBoundedInvariant(dir, { maxBytes: 1000 });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /big\.log/);
  assert.doesNotMatch(r.message ?? '', /small\.log/);
});

test('logs.rotation_bounded: repair archives losslessly, truncates in place, then reports ok', async () => {
  const dir = freshLogsDir();
  const content = 'line one\nline two\n'.repeat(100);
  writeFileSync(join(dir, 'daemon.log'), content);
  const inoBefore = statSync(join(dir, 'daemon.log')).ino;
  const inv = logsRotationBoundedInvariant(dir, {
    maxBytes: 500,
    now: () => new Date('2026-08-31T12:00:00Z'),
  });
  await inv.repair?.();
  // Truncated in place: same inode (open fds keep working), zero length.
  const st = statSync(join(dir, 'daemon.log'));
  assert.equal(st.size, 0);
  assert.equal(st.ino, inoBefore);
  // Archive holds the exact prior content.
  const gz = readFileSync(join(dir, 'daemon-2026-08-31.log.gz'));
  assert.equal(gunzipSync(gz).toString(), content);
  assert.equal((await inv.check()).ok, true);
});

test('logs.rotation_bounded: prunes archives beyond the retention count, newest kept', async () => {
  const dir = freshLogsDir();
  writeFileSync(join(dir, 'daemon.log'), 'x'.repeat(2000));
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
    writeFileSync(join(dir, `daemon-${d}.log.gz`), 'old');
  }
  const inv = logsRotationBoundedInvariant(dir, {
    maxBytes: 1000,
    keepArchives: 2,
    now: () => new Date('2026-08-31T12:00:00Z'),
  });
  await inv.repair?.();
  const archives = readdirSync(dir)
    .filter((f) => f.endsWith('.log.gz'))
    .sort();
  assert.deepEqual(archives, ['daemon-2026-01-04.log.gz', 'daemon-2026-08-31.log.gz']);
});

test('logs.rotation_bounded: second cut on one day gets a time-suffixed archive name', async () => {
  const dir = freshLogsDir();
  const now = () => new Date('2026-08-31T09:30:15Z');
  const inv = logsRotationBoundedInvariant(dir, { maxBytes: 100, now });
  writeFileSync(join(dir, 'daemon.log'), 'a'.repeat(500));
  await inv.repair?.();
  writeFileSync(join(dir, 'daemon.log'), 'b'.repeat(500));
  await inv.repair?.();
  const archives = readdirSync(dir)
    .filter((f) => f.endsWith('.log.gz'))
    .sort();
  assert.deepEqual(archives, ['daemon-2026-08-31-093015.log.gz', 'daemon-2026-08-31.log.gz']);
});

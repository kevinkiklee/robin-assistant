import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLandLog, landLogPath, readLandLog } from './land-log.ts';

test('land log: appends entries and reads back the window, skipping torn lines', () => {
  const ud = mkdtempSync(join(tmpdir(), 'land-log-'));
  assert.deepEqual(readLandLog(ud, 0), []);
  appendLandLog(ud, {
    branch: 'agent/a',
    landed: true,
    reason: 'landed as abc',
    files: ['system/x.ts'],
  });
  appendFileSync(landLogPath(ud), '{"torn":\n', 'utf8');
  appendLandLog(ud, { branch: 'agent/b', landed: false, reason: 'no test in the diff', files: [] });
  const all = readLandLog(ud, 0);
  assert.deepEqual(
    all.map((e) => e.branch),
    ['agent/a', 'agent/b'],
  );
  assert.deepEqual(readLandLog(ud, Date.now() + 60_000), [], 'window excludes older entries');
});

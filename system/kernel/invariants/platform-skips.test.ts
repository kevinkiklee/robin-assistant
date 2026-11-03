import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listPlatformSkips } from './platform-skips.ts';

function put(root: string, dir: string, file: string, yaml: string) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), yaml);
}

test('listPlatformSkips: lists darwin-only integrations and jobs on linux, none on darwin', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-pskip-'));
  const ints = join(root, 'ints');
  const jobs = join(root, 'jobs');
  put(
    ints,
    'macthing',
    'integration.yaml',
    'name: macthing\nschedule: "0 * * * *"\nplatforms: [darwin]\n',
  );
  put(ints, 'anywhere', 'integration.yaml', 'name: anywhere\nschedule: "0 * * * *"\n');
  put(ints, 'bogus', 'integration.yaml', 'name: bogus\nplatforms: [windows]\n');
  put(jobs, 'macjob', 'job.yaml', 'name: macjob\nplatforms: [darwin]\n');
  const opts = { integrations: [ints], jobs: [jobs] };
  const onLinux = listPlatformSkips(root, 'linux', opts);
  assert.deepEqual(onLinux.map((s) => s.jobName).sort(), [
    'integration.macthing.tick',
    'job.macjob.run',
  ]);
  assert.equal(onLinux[0]?.reason, 'skipped — darwin-only (runs via the Mac satellite)');
  assert.deepEqual(listPlatformSkips(root, 'darwin', opts), []);
});

test('listPlatformSkips: a user-data manifest without platforms shadows a skipped builtin', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-pskip-shadow-'));
  const user = join(root, 'user');
  const builtin = join(root, 'builtin');
  put(user, 'chrome', 'integration.yaml', 'name: chrome\n');
  put(builtin, 'chrome', 'integration.yaml', 'name: chrome\nplatforms: [darwin]\n');
  assert.deepEqual(
    listPlatformSkips(root, 'linux', { integrations: [user, builtin], jobs: [] }),
    [],
  );
});

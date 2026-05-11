import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseJobFile } from '../../cognition/jobs/loader.js';

test('meta-calibration-narrative manifest exists with schedule 30 5 * * 0', () => {
  const p = path.resolve(
    import.meta.dirname,
    '../../cognition/jobs/builtin/meta-calibration-narrative.md',
  );
  assert.ok(fs.existsSync(p), `manifest missing at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /name: meta-calibration-narrative/);
  assert.match(src, /schedule: "30 5 \* \* 0"/);
  assert.match(src, /runtime: internal/);
  assert.match(src, /enabled: true/);
  assert.match(src, /manually_runnable: true/);
});

test('meta-calibration-narrative manifest parses via loader', () => {
  const p = path.resolve(
    import.meta.dirname,
    '../../cognition/jobs/builtin/meta-calibration-narrative.md',
  );
  const job = parseJobFile(p, 'builtin');
  assert.equal(job.name, 'meta-calibration-narrative');
  assert.equal(job.schedule, '30 5 * * 0');
  assert.equal(job.runtime, 'internal');
  assert.equal(job.enabled, true);
});

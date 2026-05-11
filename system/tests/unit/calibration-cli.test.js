// tests/unit/calibration-cli.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { calibrationShow } = await import('../../runtime/cli/commands/calibration-show.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('calibration show — null prints no-data message', async () => {
  const out = capture();
  await calibrationShow([], { out: out.fn, getCalibration: async () => null });
  assert.match(out.lines.join('\n'), /no calibration data yet/);
});

test('calibration show — populated prints by_kind rows with percentages', async () => {
  const out = capture();
  await calibrationShow([], {
    out: out.fn,
    getCalibration: async () => ({
      last_computed_at: 1715000000000,
      total_open: 3,
      total_resolved: 7,
      by_kind: {
        career: { accuracy: 0.857, resolved: 7 },
        health: { accuracy: 0.5, resolved: 4 },
      },
    }),
  });
  const joined = out.lines.join('\n');
  assert.match(joined, /total_open=3/);
  assert.match(joined, /total_resolved=7/);
  assert.match(joined, /career/);
  assert.match(joined, /86%/);
  assert.match(joined, /health/);
  assert.match(joined, /50%/);
});

test('calibration show — empty by_kind prints no-resolved message', async () => {
  const out = capture();
  await calibrationShow([], {
    out: out.fn,
    getCalibration: async () => ({
      last_computed_at: null,
      total_open: 2,
      total_resolved: 0,
      by_kind: {},
    }),
  });
  const joined = out.lines.join('\n');
  assert.match(joined, /no resolved predictions yet/);
});

// End-to-end template smoke: a baseline arm and a 3-day promotion gate on the same
// 21-day stream, inline, scored and privacy-scanned. No network, no paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Arm } from './copy/arm.ts';
import { runCopy } from './copy/run-copy.ts';
import { scanText } from './privacy/forbidden.ts';
import { buildFixture } from './render/fixture.ts';
import { type CopyScore, scoreCopy } from './score/score-copy.ts';
import { paramsWith } from './script/params.ts';

test('e2e template: baseline vs 3-day gate on one 21-day stream', {
  timeout: 600_000,
}, async () => {
  const fx = mkdtempSync(join(tmpdir(), 'lab-e2e-fx-'));
  const out = mkdtempSync(join(tmpdir(), 'lab-e2e-run-'));
  buildFixture(fx, paramsWith({ horizonDays: 21 }), 61);

  const scores: Record<string, CopyScore> = {};
  const t0 = Date.now();
  for (const arm of [
    { name: 'baseline' },
    { name: 'gate-3d', tuning: { promoteAgeDays: 3 } },
  ] as Arm[]) {
    const run = await runCopy({
      fixtureDir: fx,
      arm,
      outDir: out,
      mode: 'inline',
      livePaths: ['/nonexistent-live'],
    });
    assert.equal(run.results.length, 21);
    for (const r of run.results) {
      assert.deepEqual(r.unhandledPrompts, [], `${arm.name} day ${r.day} unhandled prompts`);
      assert.deepEqual(r.disclosureSessionsSkipped, [], `${arm.name} skipped sessions`);
      assert.deepEqual(r.disclosureSessionsUnextracted, [], `${arm.name} unextracted sessions`);
      assert.deepEqual(r.errors, [], `${arm.name} day ${r.day} pipeline errors`);
    }
    const score = scoreCopy(run.sandboxRoot, fx);
    const text = readFileSync(join(run.sandboxRoot, 'score.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), score, 'score.json round-trips');
    assert.deepEqual(scanText(text), [], `${arm.name} score.json leaks forbidden text`);
    scores[arm.name] = score;
  }
  const wallMs = Date.now() - t0;

  const b = scores.baseline.metrics;
  const g = scores['gate-3d'].metrics;
  const pick = (m: typeof b) => ({
    records: m.records,
    staleness: m.staleness,
    coverage: m.coverage,
    phantomPer100: m.phantomPer100,
    resurrections: m.resurrections,
    latency: m.latency,
  });
  process.stdout.write(
    `[e2e] wall=${Math.round(wallMs / 1000)}s\n` +
      `baseline: ${JSON.stringify(pick(b))}\n` +
      `gate-3d:  ${JSON.stringify(pick(g))}\n`,
  );
  for (const [name, m] of [
    ['baseline', b],
    ['gate-3d', g],
  ] as const) {
    assert.ok(m.latency.events > 0, `${name} latency has no events`);
  }
  // Deterministic stream: with events in both arms, a 3-day gate must land strictly sooner.
  assert.ok(
    g.latency.survivalAt['7'] < b.latency.survivalAt['7'],
    `gate-3d survivalAt[7]=${g.latency.survivalAt['7']} must be < baseline ${b.latency.survivalAt['7']}`,
  );
});

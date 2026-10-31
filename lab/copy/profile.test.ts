// lab/copy/profile.test.ts — the §3.3 per-step belief-write audit
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { runDream } from '../../system/brain/cognition/dream.ts';
import { clockDate } from '../../system/lib/clock.ts';
import { renderTemplate, type StreamItem } from '../render/template.ts';
import { generateScript } from '../script/generate.ts';
import { paramsWith } from '../script/params.ts';
import { parseArm } from './arm.ts';
import { EXCLUDED_STEPS, labSteps, TEMPLATE_EXCLUDED_STEPS } from './profile.ts';
import { callItem, groupByDay, type Rig, rig, runDays } from './test-rig.ts';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function beliefState(r: Rig) {
  const q = (sql: string) => r.db.prepare(sql).all();
  const content = join(r.sb.userDataDir, 'content');
  return {
    beliefs: q(`SELECT id, payload FROM events WHERE kind = 'belief.update' ORDER BY id`),
    candidates: q('SELECT id, status, topic, claim FROM belief_candidates ORDER BY id'),
    entities: q('SELECT COUNT(*) AS n FROM entities'),
    corrections: q('SELECT id, applied FROM corrections ORDER BY id'),
    docs: files(content)
      .sort()
      .map((p) => [
        relative(content, p),
        createHash('sha256').update(readFileSync(p)).digest('hex'),
      ]),
  };
}

test('profile: every excluded dream step leaves belief state untouched', {
  timeout: 120_000,
}, async () => {
  const r = rig();
  try {
    const s = generateScript(
      paramsWith({
        horizonDays: 9,
        docShare: 1, // every trip disclosure goes to a decision doc, so content/ has docs
        assistant: { callRate: 1, omitted: 0, sloppyTopic: 0, wrongValue: 0.3 },
      }),
      42,
    );
    const byDay = groupByDay(renderTemplate(s));
    const add = (day: number, item: StreamItem) => {
      byDay[day] ??= [];
      byDay[day].push(item);
    };
    // A 9-day script has no reassert yet, so no record_correction: seed a wrong head and
    // its correction by hand so the corrections table is non-empty.
    add(
      0,
      callItem(
        'seed-wrong',
        0,
        1300,
        'believe',
        'wrong-value',
        'amber-mesa-trip',
        'amber mesa trip',
        'dropped',
      ),
    );
    add(
      1,
      callItem(
        'seed-fix',
        1,
        1300,
        'record_correction',
        'correct',
        'amber-mesa-trip',
        'amber mesa trip',
        'booked',
      ),
    );
    // A reordered duplicate topic (same tokens, Levenshtein-far so believe() keeps it
    // separate) gives `topics` a pair to nominate.
    add(
      2,
      callItem(
        'seed-dup',
        2,
        1300,
        'believe',
        'correct',
        'amber-mesa-trip',
        'amber mesa trip',
        'booked',
        'trip-amber-mesa',
      ),
    );
    await runDays(r, byDay, 9);
    const seeded = beliefState(r);
    assert.ok(seeded.beliefs.length > 0, 'seed produced no heads');
    assert.ok(seeded.candidates.length > 0, 'seed produced no candidates');
    assert.ok(seeded.corrections.length > 0, 'seed produced no corrections');
    assert.ok(seeded.docs.length > 0, 'seed produced no docs');
    // Not seeded, by construction of template mode:
    // - entities: the template answers biographer.entities with none, so the table stays empty.
    // - depth: read-only queries (decision replays, prediction calibration, deadlines) that
    //   only feed the journal text; there is no belief state for it to write.
    // - digest: composes a learning-digest event from the counters; it runs over the seeded
    //   state above but its only write is that event (not a belief.update).
    for (const step of [...EXCLUDED_STEPS, ...TEMPLATE_EXCLUDED_STEPS]) {
      const before = beliefState(r);
      const unhandled = r.template.stats.unhandled.length;
      await runDream(r.db, r.llm, clockDate(), { domainGating: true, steps: new Set([step]) });
      assert.deepEqual(beliefState(r), before, step);
      if (step === 'topics') {
        // `topics` reached its LLM merge judge on the seeded duplicate; the template cannot
        // answer it (Ruling 6), so in template mode it is a no-op by refusal, not by absence.
        assert.ok(r.template.stats.unhandled.length > unhandled, 'topics never reached its judge');
      }
    }
  } finally {
    r.done();
  }
});

test('profile: labSteps excludes the audited steps and template-only steps', () => {
  const t = labSteps('template');
  const c = labSteps('config');
  for (const s of EXCLUDED_STEPS) assert.ok(!t.has(s) && !c.has(s));
  assert.ok(!t.has('topics') && c.has('topics'));
  assert.ok(t.has('lifecycle') && t.has('expire') && t.has('corrections'));
});

test('arm: parseArm validates names, tuning and steps', () => {
  assert.deepEqual(parseArm({ name: 'gate-3d', tuning: { promoteAgeDays: 3 } }), {
    name: 'gate-3d',
    tuning: { promoteAgeDays: 3 },
  });
  assert.throws(() => parseArm({ name: 'Gate 3d' }), /arm name/);
  assert.throws(() => parseArm({ name: 'x', tuning: { promoteAgeDay: 3 } }), /unknown tuning key/);
  assert.throws(() => parseArm({ name: 'x', steps: ['lifecyle'] }), /unknown dream step/);
});

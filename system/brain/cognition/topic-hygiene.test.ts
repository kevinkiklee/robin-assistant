import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { quantizeToInt8Json } from '../memory/vec-quantize.ts';
import { runTopicHygiene, topicTokens } from './topic-hygiene.ts';

// Fixtures name the operator "Sam"; pin the profile so the name-aware topic and
// claim filters see it instead of whatever user-data/config/operator.yaml holds.
setOperatorProfileForTests({
  name: 'Sam',
  context: null,
  aliases: [],
  privateTerms: [],
  home: null,
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-topic-hygiene-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Seed a belief head the way legacy pre-§C1 heads actually exist: a raw
 *  belief.update event under the EXACT slug (believe() would canonicalize it). */
function seedBelief(db: ReturnType<typeof freshDb>, topic: string, claim: string, n: number) {
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: claim,
    payload: {
      topic,
      supersedes: null,
      confidence: 0.9,
      sources: [],
      retracted: false,
      provenance: 'first-party',
      external_id: `belief:test-${n}:${topic}`,
    },
  });
}

/** Minimal judge stub: returns the given verdicts for whatever batch it sees. */
function fakeJudge(verdicts: unknown): LLMDispatcher {
  return {
    invoke: async () => ({
      text: '',
      structured: { verdicts },
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'fake',
    }),
  } as unknown as LLMDispatcher;
}

const FAMILY = [
  ['bakery-shift-schedule', 'Riley opens the bakery on Mondays, Sam closes on Fridays.'],
  [
    'sam-bakery-shift-schedule',
    'Sam and Riley split bakery shifts: Riley opens Mondays, Sam closes Fridays.',
  ],
] as const;

test('topicTokens: strips §C1 modifier tokens and connectives', () => {
  assert.deepEqual(topicTokens('sam-bakery-shift-schedule'), ['bakery', 'shift', 'schedule']);
  assert.deepEqual(topicTokens('sams-bike-light-status'), ['bike', 'light']);
});

test('topic-hygiene: no-ops without an LLM', async () => {
  const db = freshDb();
  for (const [i, [t, c]] of FAMILY.entries()) seedBelief(db, t, c, i);
  const report = await runTopicHygiene(db, null);
  assert.equal(report.merged, 0);
  assert.equal(report.pairsJudged, 0);
  closeDb(db);
});

test('topic-hygiene: merges a same-fact pair — dupe gets a retracted pointer, survivor untouched', async () => {
  const db = freshDb();
  for (const [i, [t, c]] of FAMILY.entries()) seedBelief(db, t, c, i);
  seedBelief(db, 'whoop-recovery', 'Recovery dips after hot nights.', 9);

  const report = await runTopicHygiene(db, fakeJudge([{ pair: 0, same_fact: true, keep: 'a' }]));
  assert.equal(report.pairsJudged, 1);
  assert.equal(report.merged, 1);

  // Read heads by EXACT stored slug (recallBelief canonicalizes its topic arg,
  // which would collapse the legacy key onto the survivor's head).
  const headOf = (topic: string) =>
    db
      .prepare(
        `SELECT json_extract(e.payload,'$.retracted') AS retracted, COALESCE(c.body,'') AS claim
           FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = 'belief.update' AND json_extract(e.payload,'$.topic') = ?
          ORDER BY e.id DESC LIMIT 1`,
      )
      .get(topic) as { retracted: unknown; claim: string };
  const records = FAMILY.map(([t]) => ({ topic: t, ...headOf(t) }));
  const isRetracted = (r: { retracted: unknown }) => r.retracted === 1 || r.retracted === true;
  const retracted = records.filter(isRetracted);
  const alive = records.filter((r) => !isRetracted(r));
  assert.equal(retracted.length, 1);
  assert.equal(alive.length, 1);
  assert.match(retracted[0].claim, /Merged into topic '/);
  assert.match(retracted[0].claim, new RegExp(alive[0].topic));
  // The unrelated topic is untouched.
  assert.equal(isRetracted(headOf('whoop-recovery')), false);
  closeDb(db);
});

test('topic-hygiene: distinct verdict is durable — the pair is never re-nominated', async () => {
  const db = freshDb();
  for (const [i, [t, c]] of FAMILY.entries()) seedBelief(db, t, c, i);

  const first = await runTopicHygiene(db, fakeJudge([{ pair: 0, same_fact: false, keep: 'a' }]));
  assert.equal(first.markedDistinct, 1);
  assert.equal(first.merged, 0);

  // A merge-happy judge on the second run never sees the pair.
  const second = await runTopicHygiene(db, fakeJudge([{ pair: 0, same_fact: true, keep: 'a' }]));
  assert.equal(second.pairsConsidered, 0);
  assert.equal(second.merged, 0);
  closeDb(db);
});

test('topic-hygiene: lexically unrelated topics are never paired', async () => {
  const db = freshDb();
  seedBelief(db, 'bakery-shift-schedule', 'Riley opens the bakery on Mondays.', 0);
  seedBelief(db, 'whoop-recovery', 'Recovery dips after hot nights.', 1);
  const report = await runTopicHygiene(db, fakeJudge([]));
  assert.equal(report.pairsConsidered, 0);
  closeDb(db);
});

test('topic-hygiene: never chains merges in one run — a pair touching a retired key is skipped', async () => {
  const db = freshDb();
  // Three keys of one family → nominates A|B, A|C, B|C. A merge-happy judge
  // approves all three; only non-overlapping merges may land.
  seedBelief(db, 'acme-stand-mixer', 'The stand mixer is the everyday mixer.', 0);
  seedBelief(db, 'acme-x-stand-mixer', 'The Acme X stand mixer is the everyday mixer.', 1);
  seedBelief(db, 'mixer-acme-x-stand', 'Their everyday mixer is the Acme X stand mixer.', 2);

  const report = await runTopicHygiene(
    db,
    fakeJudge([
      { pair: 0, same_fact: true, keep: 'a' },
      { pair: 1, same_fact: true, keep: 'a' },
      { pair: 2, same_fact: true, keep: 'a' },
    ]),
  );
  // Two dupes may fold into the ONE live survivor; the pair between the two
  // retired keys is skipped. Never three retirements, never a chain.
  assert.equal(report.merged, 2);
  const retractedTopics = new Set(
    (
      db
        .prepare(
          `SELECT json_extract(payload,'$.topic') AS t FROM events
            WHERE kind = 'belief.update' AND json_extract(payload,'$.retracted') IN (1, 'true')`,
        )
        .all() as Array<{ t: string }>
    ).map((r) => r.t),
  );
  assert.equal(retractedTopics.size, 2);
  // The invariant: no merge pointer targets a retired key.
  const targets = db
    .prepare(
      `SELECT DISTINCT json_extract(payload,'$.merged_into') AS s FROM events
        WHERE kind = 'belief.update' AND json_extract(payload,'$.merged_into') IS NOT NULL`,
    )
    .all() as Array<{ s: string }>;
  for (const t of targets) assert.equal(retractedTopics.has(t.s), false);
  closeDb(db);
});

test('topic-hygiene: maxMerges caps how much one run can change', async () => {
  const db = freshDb();
  for (const [i, [t, c]] of FAMILY.entries()) seedBelief(db, t, c, i);
  seedBelief(db, 'bike-light-units', 'Two Acme lamps on the porch.', 4);
  seedBelief(db, 'bike-light-system', 'The porch light system is two Acme lamps.', 5);

  const report = await runTopicHygiene(
    db,
    fakeJudge([
      { pair: 0, same_fact: true, keep: 'a' },
      { pair: 1, same_fact: true, keep: 'a' },
    ]),
    { maxMerges: 1 },
  );
  assert.equal(report.merged, 1);
  closeDb(db);
});

/** Embed a seeded head's claim: a unit vector along `axis`, nudged by `jitter`. */
function embedHead(db: ReturnType<typeof freshDb>, topic: string, axis: number, jitter = 0) {
  const row = db
    .prepare(
      `SELECT content_ref AS ref FROM events
        WHERE kind = 'belief.update' AND json_extract(payload,'$.topic') = ?`,
    )
    .get(topic) as { ref: number };
  const vec = new Array(3072).fill(0);
  vec[axis] = 1;
  vec[axis + 1] = jitter;
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
    BigInt(row.ref),
    quantizeToInt8Json(vec),
  );
}

test('topic-hygiene: embedding nominates paraphrases the lexical pass never pairs', async () => {
  const db = freshDb();
  // Zero shared slug tokens — lexical nomination can't see this pair.
  seedBelief(db, 'employer', 'Sam works at Acme.', 0);
  seedBelief(db, 'workplace', "Sam's employer is Acme.", 1);
  seedBelief(db, 'favorite-film', 'Sam loves The Long Field.', 2);
  embedHead(db, 'employer', 0);
  embedHead(db, 'workplace', 0, 0.05);
  embedHead(db, 'favorite-film', 100);

  let seenPairs = '';
  const judge = {
    invoke: async (_role: string, req: { messages: Array<{ content: string }> }) => {
      seenPairs = req.messages[0].content;
      return {
        text: '',
        structured: { verdicts: [{ pair: 0, same_fact: true, keep: 'a' }] },
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'fake',
      };
    },
  } as unknown as LLMDispatcher;

  const report = await runTopicHygiene(db, judge, { probeOffset: 0 });
  assert.equal(report.pairsConsidered, 1, 'only the paraphrase pair, not the film');
  assert.match(seenPairs, /employer/);
  assert.match(seenPairs, /workplace/);
  assert.doesNotMatch(seenPairs, /favorite-film/);
  assert.equal(report.merged, 1);
  closeDb(db);
});

test('topic-hygiene: embedProbes 0 falls back to lexical-only nomination', async () => {
  const db = freshDb();
  seedBelief(db, 'employer', 'Sam works at Acme.', 0);
  seedBelief(db, 'workplace', "Sam's employer is Acme.", 1);
  embedHead(db, 'employer', 0);
  embedHead(db, 'workplace', 0, 0.05);
  const report = await runTopicHygiene(db, fakeJudge([]), { embedProbes: 0 });
  assert.equal(report.pairsConsidered, 0);
  closeDb(db);
});

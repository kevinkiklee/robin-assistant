import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { InvokeRequest } from '../llm/types.ts';
import { believe } from '../memory/belief.ts';
import { insertBeliefCandidate, listOpenContradictions } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import type { ProvenanceClass } from '../memory/provenance.ts';
import { JUDGE_REASON, judgeAgainstHeads, reconcileConflicts } from './belief-reconcile.ts';
import { promoteStableCandidates } from './dream.ts';

type Db = ReturnType<typeof openDb>;

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'robin-belief-reconcile-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const sqlTs = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const daysAgo = (n: number, now = new Date()) => sqlTs(new Date(now.getTime() - n * 86_400_000));

/** Insert a candidate aged past the 7-day promotion gate (or with explicit fields). */
function seedCandidate(
  db: Db,
  topic: string,
  claim: string,
  opts: {
    provenance?: ProvenanceClass;
    ageDays?: number;
    status?: string;
    reason?: string | null;
    resolvedDaysAgo?: number;
  } = {},
): number {
  const { id } = insertBeliefCandidate(db, {
    topic,
    claim,
    confidence: 0.9,
    provenance: opts.provenance ?? 'first-party',
  });
  db.prepare(
    `UPDATE belief_candidates SET created_at = ?, status = ?, resolved_reason = ?, resolved_at = ? WHERE id = ?`,
  ).run(
    daysAgo(opts.ageDays ?? 10),
    opts.status ?? 'pending',
    opts.reason ?? null,
    opts.resolvedDaysAgo != null ? daysAgo(opts.resolvedDaysAgo) : null,
    id,
  );
  return id;
}

function row(db: Db, id: number) {
  return db
    .prepare(`SELECT status, resolved_reason FROM belief_candidates WHERE id = ?`)
    .get(id) as {
    status: string;
    resolved_reason: string | null;
  };
}

function headClaim(db: Db, topic: string): string | null {
  const r = db
    .prepare(
      `SELECT c.body AS claim FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind = 'belief.update' AND json_extract(e.payload,'$.topic') = ?
        ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
    )
    .get(topic) as { claim: string | null } | undefined;
  return r?.claim ?? null;
}

/**
 * Fake classify judge: answers each ITEM by looking up its `new:` claim in
 * `byClaim` (unknown claims are omitted, i.e. no verdict). Records every request.
 */
function fakeJudge(byClaim: Record<string, string>) {
  const calls: InvokeRequest[] = [];
  const roles: string[] = [];
  const llm = {
    invoke: async (role: string, req: InvokeRequest) => {
      roles.push(role);
      calls.push(req);
      const content = String(req.messages[0]?.content ?? '');
      const verdicts: Array<{ item: number; verdict: string }> = [];
      for (const block of content.split(/\n(?=ITEM )/)) {
        const n = Number(block.match(/^ITEM (\d+)/)?.[1]);
        const claim = block.match(/\n {2}new: (.*)$/m)?.[1]?.trim() ?? '';
        if (byClaim[claim]) verdicts.push({ item: n, verdict: byClaim[claim] });
      }
      return {
        text: '',
        structured: { verdicts },
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'fake',
      };
    },
  } as unknown as LLMDispatcher;
  return { llm, calls, roles };
}

function throwingJudge(): LLMDispatcher {
  return {
    invoke: async () => {
      throw new Error("No provider assigned for role 'classify'");
    },
  } as unknown as LLMDispatcher;
}

// ── judgeAgainstHeads ────────────────────────────────────────────────────────

test('judgeAgainstHeads: batches items, uses the classify role, keys verdicts by id', async () => {
  const { llm, calls, roles } = fakeJudge({ c0: 'same', c1: 'refines', c4: 'contradicts' });
  const head = { id: 1, claim: 'h', ts: '2026-07-01T00:00:00Z', provenance: null };
  const items = [0, 1, 2, 3, 4].map((i) => ({ id: 100 + i, topic: 't', claim: `c${i}`, head }));
  const out = await judgeAgainstHeads(llm, items, 2);
  assert.equal(calls.length, 3, '5 items at batch 2 → 3 calls');
  assert.deepEqual([...new Set(roles)], ['classify']);
  assert.ok(calls[0].outputSchema, 'structured output requested');
  assert.equal(out.get(100), 'same');
  assert.equal(out.get(101), 'refines');
  assert.equal(out.get(104), 'contradicts');
  assert.equal(out.has(102), false, 'no verdict returned → absent');
});

test('judgeAgainstHeads: a throwing LLM or unparseable reply yields no verdicts', async () => {
  const head = { id: 1, claim: 'h', ts: '2026-07-01', provenance: null };
  const items = [{ id: 1, topic: 't', claim: 'c', head }];
  assert.equal((await judgeAgainstHeads(throwingJudge(), items)).size, 0);
  const garbage = {
    invoke: async () => ({ text: 'I think it refines', structured: { verdicts: 'x' } }),
  } as unknown as LLMDispatcher;
  assert.equal((await judgeAgainstHeads(garbage, items)).size, 0);
  assert.equal((await judgeAgainstHeads(null, items)).size, 0);
});

test('judgeAgainstHeads: falls back to JSON in the text when structured is missing', async () => {
  const head = { id: 1, claim: 'h', ts: '2026-07-01', provenance: null };
  const llm = {
    invoke: async () => ({ text: 'ok {"verdicts":[{"item":0,"verdict":"refines"}]}' }),
  } as unknown as LLMDispatcher;
  const out = await judgeAgainstHeads(llm, [{ id: 7, topic: 't', claim: 'c', head }]);
  assert.equal(out.get(7), 'refines');
});

// ── promoteStableCandidates with the judge ───────────────────────────────────

test('promote: a refinement supersedes the head through believe()', async () => {
  const db = freshDb();
  // Written on an earlier day: a same-day believe() upserts the head in place.
  const h = believe(db, null, {
    topic: 'birthday',
    claim: "Sam's birthday is March 14",
    provenance: 'first-party',
    date: '2026-07-01',
  });
  const c = seedCandidate(db, 'birthday', 'Sam is 30; he turned 30 on March 14');
  const { llm } = fakeJudge({ 'Sam is 30; he turned 30 on March 14': 'refines' });

  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.promoted, 1);
  assert.equal(res.refined, 1);
  assert.equal(res.conflicted, 0);
  assert.deepEqual(row(db, c), { status: 'promoted', resolved_reason: JUDGE_REASON.refines });
  assert.equal(headClaim(db, 'birthday'), 'Sam is 30; he turned 30 on March 14');
  const newHead = db
    .prepare(
      `SELECT json_extract(payload,'$.supersedes') AS sup FROM events
        WHERE kind='belief.update' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { sup: number };
  assert.equal(newHead.sup, h.eventId, 'supersession chain points at the old head');
  closeDb(db);
});

test('promote: same → merged, contradicts → tagged conflicted, unrelated → conflicted', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  believe(db, null, { topic: 'home-city', claim: 'Sam lives in Portland' });
  believe(db, null, { topic: 'trip-plan', claim: 'Sam plans a coast trip' });
  const same = seedCandidate(db, 'fav-color', 'Red is the color Sam likes best');
  const contra = seedCandidate(db, 'home-city', 'Sam lives in Denver');
  const unrel = seedCandidate(db, 'trip-plan', 'Sam bought a tent');
  const { llm } = fakeJudge({
    'Red is the color Sam likes best': 'same',
    'Sam lives in Denver': 'contradicts',
    'Sam bought a tent': 'unrelated',
  });

  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.merged, 1);
  assert.equal(res.conflicted, 2);
  assert.equal(res.promoted, 0);
  assert.equal(row(db, same).status, 'merged');
  assert.deepEqual(row(db, contra), {
    status: 'conflicted',
    resolved_reason: JUDGE_REASON.contradicts,
  });
  assert.deepEqual(row(db, unrel), {
    status: 'conflicted',
    resolved_reason: JUDGE_REASON.unrelated,
  });
  assert.equal(headClaim(db, 'home-city'), 'Sam lives in Portland', 'head untouched');

  const open = listOpenContradictions(db, 10);
  assert.equal(open.length, 1, 'only judged contradictions are listed');
  assert.equal(open[0].id, contra);
  assert.equal(open[0].claim, 'Sam lives in Denver');
  assert.equal(open[0].headClaim, 'Sam lives in Portland');
  closeDb(db);
});

test('promote: LLM failure falls back to the deterministic gate — never promotes', async () => {
  const db = freshDb();
  believe(db, null, {
    topic: 'starter-name',
    claim: "Sam's sourdough starter is Clementine, aka Clem",
  });
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  const rephrase = seedCandidate(db, 'starter-name', "Sam's sourdough starter is Clementine");
  const diverge = seedCandidate(db, 'fav-color', 'Sam likes blue');

  const res = await promoteStableCandidates(db, new Date(), throwingJudge());
  assert.equal(res.promoted, 0);
  assert.equal(res.merged, 1);
  assert.equal(res.conflicted, 1);
  assert.deepEqual(row(db, rephrase), { status: 'merged', resolved_reason: null });
  assert.deepEqual(row(db, diverge), { status: 'conflicted', resolved_reason: null });
  assert.equal(listOpenContradictions(db).length, 0, 'unjudged conflicts are not surfaced');
  closeDb(db);
});

test('promote: a missing verdict for one item falls back for that item only', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  believe(db, null, { topic: 'home-city', claim: 'Sam lives in Portland' });
  const judged = seedCandidate(db, 'fav-color', 'Sam likes red, specifically crimson');
  const unjudged = seedCandidate(db, 'home-city', 'Sam lives in Denver');
  const { llm } = fakeJudge({ 'Sam likes red, specifically crimson': 'refines' });

  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.refined, 1);
  assert.equal(row(db, judged).status, 'promoted');
  assert.deepEqual(row(db, unjudged), { status: 'conflicted', resolved_reason: null });
  closeDb(db);
});

test('promote: judge budget per run — overflow stays pending for the next run', async () => {
  const db = freshDb();
  const ids: number[] = [];
  const verdicts: Record<string, string> = {};
  // Claims far apart in edit distance, so the near-duplicate pre-pass keeps them all.
  const claims = [
    'Sam bought a tent',
    'Max moved to Austin last spring',
    'The garage has two old bikes',
    'Sam bikes along the river often',
    'Dinner on Fridays is usually ramen',
  ];
  for (const [i, claim] of claims.entries()) {
    believe(db, null, { topic: `topic-${i}`, claim: `Head ${i}: something else entirely` });
    verdicts[claim] = 'unrelated';
    ids.push(seedCandidate(db, `topic-${i}`, claim));
  }
  const { llm, calls } = fakeJudge(verdicts);
  const res = await promoteStableCandidates(db, new Date(), llm, { maxJudged: 3 });
  assert.equal(res.conflicted, 3);
  assert.equal(res.deferred, 2);
  assert.equal(calls.length, 1);
  assert.equal(row(db, ids[3]).status, 'pending');
  assert.equal(row(db, ids[4]).status, 'pending');

  // Next run picks the deferred ones up.
  const res2 = await promoteStableCandidates(db, new Date(), llm, { maxJudged: 3 });
  assert.equal(res2.conflicted, 2);
  assert.equal(row(db, ids[4]).status, 'conflicted');
  closeDb(db);
});

test('promote: no LLM → no budget cap, old behavior for every divergent candidate', async () => {
  const db = freshDb();
  const claims = [
    'Sam bought a tent',
    'Max moved to Austin last spring',
    'The garage has two old bikes',
    'Dinner on Fridays is usually ramen',
  ];
  for (const [i, claim] of claims.entries()) {
    believe(db, null, { topic: `topic-${i}`, claim: `Head ${i}: something else entirely` });
    seedCandidate(db, `topic-${i}`, claim);
  }
  const res = await promoteStableCandidates(db, new Date(), null, { maxJudged: 1 });
  assert.equal(res.conflicted, 4);
  assert.equal(res.deferred, 0);
  closeDb(db);
});

test('promote: two refinements of one head in a run — only the first lands', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'coast-trip', claim: 'Sam may visit the coast' });
  const a = seedCandidate(db, 'coast-trip', 'Sam will visit the coast in May 2027');
  const b = seedCandidate(db, 'coast-trip', 'Sam booked the coast trip, May 2027');
  const { llm } = fakeJudge({
    'Sam will visit the coast in May 2027': 'refines',
    'Sam booked the coast trip, May 2027': 'refines',
  });
  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.refined, 1);
  assert.equal(res.deferred, 1);
  assert.equal(row(db, a).status, 'promoted');
  assert.equal(row(db, b).status, 'pending', 're-judged next run against the new head');
  closeDb(db);
});

test('promote: a weaker-provenance refinement never supersedes a first-party head', async () => {
  const db = freshDb();
  believe(db, null, {
    topic: 'license',
    claim: 'Sam filed a passport renewal in Jan 2023',
    provenance: 'first-party',
  });
  const c = seedCandidate(db, 'license', 'Sam is a traveler who filed a passport renewal', {
    provenance: 'inferred',
  });
  const { llm } = fakeJudge({ 'Sam is a traveler who filed a passport renewal': 'refines' });
  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.promoted, 0);
  assert.equal(res.conflicted, 1);
  assert.deepEqual(row(db, c), { status: 'conflicted', resolved_reason: 'judge:refines-weaker' });
  assert.equal(headClaim(db, 'license'), 'Sam filed a passport renewal in Jan 2023');
  closeDb(db);
});

test('promote: a refinement still passes the P3 formation gate', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  const { id } = insertBeliefCandidate(db, {
    topic: 'fav-color',
    claim: 'Sam likes deep red',
    confidence: 0.2, // below the first-party threshold
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(daysAgo(10), id);
  const { llm } = fakeJudge({ 'Sam likes deep red': 'refines' });
  const res = await promoteStableCandidates(db, new Date(), llm);
  assert.equal(res.gateBlocked, 1);
  assert.equal(res.promoted, 0);
  assert.deepEqual(row(db, id), {
    status: 'rejected',
    resolved_reason: 'below-threshold-for-class',
  });
  assert.equal(headClaim(db, 'fav-color'), 'Sam likes red');
  closeDb(db);
});

test('promote: young candidates are never judged (7-day gate holds)', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  const c = seedCandidate(db, 'fav-color', 'Sam likes crimson red', { ageDays: 2 });
  const { llm, calls } = fakeJudge({ 'Sam likes crimson red': 'refines' });
  await promoteStableCandidates(db, new Date(), llm);
  assert.equal(calls.length, 0);
  assert.equal(row(db, c).status, 'pending');
  closeDb(db);
});

// ── reconcileConflicts (CLI backfill) ────────────────────────────────────────

function seedBacklog(db: Db) {
  believe(db, null, { topic: 'birthday', claim: "Sam's birthday is March 14" });
  believe(db, null, { topic: 'home-city', claim: 'Sam lives in Portland' });
  believe(db, null, { topic: 'fav-color', claim: 'Sam likes red' });
  const refines = seedCandidate(db, 'birthday', 'Sam turned 30 on March 14', {
    status: 'conflicted',
  });
  const contra = seedCandidate(db, 'home-city', 'Sam lives in Denver', { status: 'conflicted' });
  const expiredSame = seedCandidate(db, 'fav-color', 'Red is the color Sam likes', {
    ageDays: 50,
    status: 'rejected',
    reason: 'stale-conflict-expiry',
    resolvedDaysAgo: 20,
  });
  const expiredContra = seedCandidate(db, 'home-city', 'Sam lives in Boston', {
    ageDays: 50,
    status: 'rejected',
    reason: 'stale-conflict-expiry',
    resolvedDaysAgo: 20,
  });
  const expiredOld = seedCandidate(db, 'birthday', 'Sam was born on March 14', {
    ageDays: 200,
    status: 'rejected',
    reason: 'stale-conflict-expiry',
    resolvedDaysAgo: 150,
  });
  const verdicts = {
    'Sam turned 30 on March 14': 'refines',
    'Sam lives in Denver': 'contradicts',
    'Red is the color Sam likes': 'same',
    'Sam lives in Boston': 'contradicts',
    'Sam was born on March 14': 'same',
  };
  return { refines, contra, expiredSame, expiredContra, expiredOld, verdicts };
}

test('reconcile: dry-run judges and reports but writes nothing', async () => {
  const db = freshDb();
  const s = seedBacklog(db);
  const { llm } = fakeJudge(s.verdicts);
  const before = db.prepare(`SELECT id, status, resolved_reason FROM belief_candidates`).all();
  const rep = await reconcileConflicts(db, llm, { includeExpired: true });
  assert.equal(rep.considered, 4, 'two conflicted + two expired inside the 120-day lookback');
  assert.equal(rep.judged, 4);
  const byId = new Map(rep.decisions.map((d) => [d.id, d]));
  assert.equal(byId.get(s.refines)?.outcome, 'promoted');
  assert.equal(byId.get(s.contra)?.outcome, 'contradiction');
  assert.equal(byId.get(s.expiredSame)?.outcome, 'merged');
  assert.equal(byId.get(s.expiredContra)?.outcome, 'unchanged');
  assert.equal(byId.has(s.expiredOld), false);
  assert.deepEqual(
    db.prepare(`SELECT id, status, resolved_reason FROM belief_candidates`).all(),
    before,
  );
  assert.equal(headClaim(db, 'birthday'), "Sam's birthday is March 14");
  closeDb(db);
});

test('reconcile: --apply writes verdicts; expired rows reopen only for same/refines', async () => {
  const db = freshDb();
  const s = seedBacklog(db);
  const { llm } = fakeJudge(s.verdicts);
  const rep = await reconcileConflicts(db, llm, { apply: true, includeExpired: true });
  assert.equal(rep.counts.promoted, 1);
  assert.equal(row(db, s.refines).status, 'promoted');
  assert.equal(headClaim(db, 'birthday'), 'Sam turned 30 on March 14');
  assert.deepEqual(row(db, s.contra), {
    status: 'conflicted',
    resolved_reason: JUDGE_REASON.contradicts,
  });
  assert.deepEqual(row(db, s.expiredSame), {
    status: 'merged',
    resolved_reason: JUDGE_REASON.same,
  });
  assert.deepEqual(row(db, s.expiredContra), {
    status: 'rejected',
    resolved_reason: 'stale-conflict-expiry',
  });
  assert.deepEqual(row(db, s.expiredOld), {
    status: 'rejected',
    resolved_reason: 'stale-conflict-expiry',
  });
  assert.deepEqual(
    listOpenContradictions(db).map((c) => c.id),
    [s.contra],
  );
  closeDb(db);
});

test('reconcile: without --include-expired only the conflicted queue is touched', async () => {
  const db = freshDb();
  const s = seedBacklog(db);
  const { llm } = fakeJudge(s.verdicts);
  const rep = await reconcileConflicts(db, llm, { apply: true });
  assert.equal(rep.considered, 2);
  assert.equal(row(db, s.expiredSame).status, 'rejected');
  closeDb(db);
});

test('reconcile: expired refinement reopens and promotes', async () => {
  const db = freshDb();
  believe(db, null, { topic: 'coast-trip', claim: 'Sam is thinking about the coast' });
  const c = seedCandidate(db, 'coast-trip', 'Sam locked the coast trip for May 2027', {
    ageDays: 45,
    status: 'rejected',
    reason: 'stale-conflict-expiry',
    resolvedDaysAgo: 10,
  });
  const { llm } = fakeJudge({ 'Sam locked the coast trip for May 2027': 'refines' });
  await reconcileConflicts(db, llm, { apply: true, includeExpired: true });
  assert.deepEqual(row(db, c), { status: 'promoted', resolved_reason: JUDGE_REASON.refines });
  assert.equal(headClaim(db, 'coast-trip'), 'Sam locked the coast trip for May 2027');
  closeDb(db);
});

test('reconcile: no LLM → every decision is no-verdict, nothing written', async () => {
  const db = freshDb();
  const s = seedBacklog(db);
  const rep = await reconcileConflicts(db, null, { apply: true, includeExpired: true });
  assert.equal(rep.judged, 0);
  assert.equal(rep.counts['no-verdict'], 4);
  assert.equal(row(db, s.refines).status, 'conflicted');
  assert.equal(row(db, s.refines).resolved_reason, null);
  closeDb(db);
});

test('reconcile: a conflicted candidate whose topic lost its head is reported no-head', async () => {
  const db = freshDb();
  const c = seedCandidate(db, 'orphan-topic', 'Some orphaned claim', { status: 'conflicted' });
  const { llm, calls } = fakeJudge({ 'Some orphaned claim': 'refines' });
  const rep = await reconcileConflicts(db, llm, { apply: true });
  assert.equal(calls.length, 0);
  assert.equal(rep.decisions[0].outcome, 'no-head');
  assert.equal(row(db, c).status, 'conflicted');
  closeDb(db);
});

test('reconcile: --limit caps the candidates judged', async () => {
  const db = freshDb();
  const s = seedBacklog(db);
  const { llm } = fakeJudge(s.verdicts);
  const rep = await reconcileConflicts(db, llm, { includeExpired: true, limit: 1 });
  assert.equal(rep.considered, 1);
  closeDb(db);
});

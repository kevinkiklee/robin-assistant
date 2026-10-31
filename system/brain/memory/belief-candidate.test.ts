import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { type BeliefRecord, recallBelief } from './belief.ts';
import {
  countPendingCandidates,
  dedupePendingCandidates,
  expireStaleCandidates,
  expireStaleConflicts,
  insertBeliefCandidate,
  insertCandidateWithDedup,
  isLowQualityClaim,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from './belief-candidate.ts';
import { closeDb, openDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'robin-belief-cand-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/**
 * A deterministic stub embedder for dedup tests. Each claim maps to a unit vector
 * along a single axis chosen by the concept keyword it contains, so paraphrases of
 * the same fact are colinear (cosine ≈ 1) and distinct facts are orthogonal
 * (cosine = 0). The actual claim wording is irrelevant — only the concept matters.
 */
function conceptLLM(): LLMDispatcher {
  const axisFor = (text: string): number => {
    const t = text.toLowerCase();
    if (/\b(e-bike|bike)\b/.test(t)) return 0;
    if (/\b(mixer|acme|x1|dough)\b/.test(t)) return 1;
    if (/\b(spreadsheet|ledger)\b/.test(t)) return 2;
    return 3;
  };
  const vecFor = (text: string): number[] => {
    const v = new Array(3072).fill(0);
    v[axisFor(text)] = 1;
    return v;
  };
  const provider: LLMProvider = {
    name: 'concept',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('nope');
    },
    embed: async (text: string | string[]) => (Array.isArray(text) ? text : [text]).map(vecFor),
  };
  const d = new LLMDispatcher();
  d.register('c', provider);
  d.assign('embed', 'c');
  return d;
}

test('dedup: a paraphrase of an existing pending candidate merges (corroboration++, no new row)', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  const a = await insertCandidateWithDedup(db, llm, {
    topic: 'ebike-model',
    claim: 'Sam owns an e-bike (model VX-2) purchased 2026-01-15.',
    confidence: 0.9,
    provenance: 'first-party',
  });
  const b = await insertCandidateWithDedup(db, llm, {
    topic: 'commute-ebike', // different slug, same fact
    claim: "Sam's e-bike (model VX-2) was bought on 2026-01-15 for commuting.",
    confidence: 0.9,
    provenance: 'first-party',
  });
  assert.equal(a.merged, false);
  assert.equal(b.merged, true);
  assert.equal(b.id, a.id); // merged into the canonical row
  assert.equal(countPendingCandidates(db), 1);
  const row = listBeliefCandidates(db, { status: 'pending' })[0];
  assert.equal(row.corroborationCount, 2);
  closeDb(db);
});

test('dedup: a semantically distinct fact is a separate candidate', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  await insertCandidateWithDedup(db, llm, {
    topic: 'ebike-model',
    claim: 'Sam owns an e-bike (model VX-2).',
    confidence: 0.9,
    provenance: 'first-party',
  });
  const mixer = await insertCandidateWithDedup(db, llm, {
    topic: 'stand-mixer',
    claim: "Sam's primary stand mixer is the Acme X1.",
    confidence: 0.9,
    provenance: 'first-party',
  });
  assert.equal(mixer.merged, false);
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('dedup: a higher-confidence paraphrase becomes canonical (protects against the wrong-value variant)', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  // The low-confidence, wrong-price variant lands first.
  const a = await insertCandidateWithDedup(db, llm, {
    topic: 'ebike-cost',
    claim: 'Sam owns an e-bike purchased for ~$615.',
    confidence: 0.6,
    provenance: 'first-party',
  });
  // A higher-confidence, corrected variant arrives and should take over canonical text.
  await insertCandidateWithDedup(db, llm, {
    topic: 'ebike-cost',
    claim: 'Sam owns an e-bike purchased for ~$735 all-in.',
    confidence: 0.9,
    provenance: 'first-party',
  });
  assert.equal(countPendingCandidates(db), 1);
  const row = listBeliefCandidates(db, { status: 'pending' })[0];
  assert.equal(row.id, a.id);
  assert.match(row.claim, /\$735/);
  assert.equal(row.confidence, 0.9);
  assert.equal(row.corroborationCount, 2);
  closeDb(db);
});

test('dedup: no embedder falls back to exact (topic, claim) match', async () => {
  const db = freshDb();
  // Same concept, different slug — without an embedder these stay separate (exact match only).
  await insertCandidateWithDedup(db, null, {
    topic: 'ebike-a',
    claim: 'Sam owns an e-bike purchased 2026-01-15.',
  });
  await insertCandidateWithDedup(db, null, {
    topic: 'ebike-b',
    claim: "Sam's e-bike was bought 2026-01-15.",
  });
  assert.equal(countPendingCandidates(db), 2);
  // Exact duplicate still dedups.
  await insertCandidateWithDedup(db, null, {
    topic: 'ebike-a',
    claim: 'Sam owns an e-bike purchased 2026-01-15.',
  });
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('dedup: low-quality dev-artifact claim is filtered before embedding (sentinel id)', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  const res = await insertCandidateWithDedup(db, llm, {
    topic: 'robin-infra',
    claim: 'Robin runs as a launchd daemon on macOS.',
  });
  assert.equal(res.id, -1);
  assert.equal(res.merged, false);
  assert.equal(countPendingCandidates(db), 0);
  closeDb(db);
});

test('sweep: collapses a paraphrase cluster to one canonical, rejecting the rest', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  // Seed three e-bike-concept paraphrases (no embeddings, like pre-dedup prod rows) under
  // different slugs, plus one distinct stand-mixer fact. The 0.95-confidence e-bike row should
  // win canonical.
  insertBeliefCandidate(db, { topic: 'ebike-a', claim: 'Sam owns an e-bike.', confidence: 0.8 });
  insertBeliefCandidate(db, {
    topic: 'ebike-b',
    claim: "Sam's e-bike (model VX-2) is his commuter.",
    confidence: 0.95,
  });
  insertBeliefCandidate(db, {
    topic: 'ebike-c',
    claim: 'Sam bought an e-bike with a mid-drive motor.',
    confidence: 0.7,
  });
  insertBeliefCandidate(db, {
    topic: 'stand-mixer',
    claim: "Sam's primary stand mixer is the Acme X1.",
    confidence: 0.9,
  });

  const report = await dedupePendingCandidates(db, llm);
  assert.equal(report.rejected, 2);
  assert.equal(countPendingCandidates(db), 2); // 1 e-bike canonical + 1 stand mixer

  const pending = listBeliefCandidates(db, { status: 'pending' });
  const bike = pending.find((c) => /e-bike/.test(c.claim));
  assert.ok(bike);
  assert.match(bike.claim, /VX-2/); // highest-confidence variant kept
  assert.equal(bike.corroborationCount, 3); // cluster size folded in

  const rejected = listBeliefCandidates(db, { status: 'rejected' });
  assert.equal(rejected.length, 2);
  for (const r of rejected) assert.equal(r.resolvedReason, 'paraphrase-dup');
  closeDb(db);
});

test('sweep: dry-run reports the cluster without mutating anything', async () => {
  const db = freshDb();
  const llm = conceptLLM();
  insertBeliefCandidate(db, { topic: 'ebike-a', claim: 'Sam owns an e-bike.', confidence: 0.8 });
  insertBeliefCandidate(db, {
    topic: 'ebike-b',
    claim: "Sam's e-bike (model VX-2).",
    confidence: 0.9,
  });
  const report = await dedupePendingCandidates(db, llm, { dryRun: true });
  assert.equal(report.rejected, 2 - 1); // one loser would be rejected
  assert.equal(countPendingCandidates(db), 2); // unchanged — dry run mutated nothing
  closeDb(db);
});

test('isLowQualityClaim: drops Robin-internals and dev-artifact claims', () => {
  const dropped = [
    ['robin-daemon', 'Robin runs as a launchd daemon on Sam’s Mac.'],
    ['askrobin-infra', 'askrobin.io caches rendered pages for five minutes'],
    [
      'deploy',
      'askrobin.io deploys to Vercel automatically via GitHub integration on push to main',
    ],
    ['recall', 'The robin daemon uses recall.js and _journal.json for memory operations.'],
    ['monorepo', 'The quillnote monorepo contains packages/core and packages/cli'],
    ['shell', "Sam has a zsh alias 'qn' that opens his quillnote inbox."],
    // Claude Code / MCP environment artifacts (gap found 2026-05-28 spot-check).
    ['mcp-config', 'Sam removed demo-mcp from the MCP servers list in his ~/.claude.json.'],
    ['mcp-spawn', "Sam's Claude Code extension spawns foo-mcp, bar-mcp, baz-mcp."],
    ['possessive', "Robin's scheduler gained self-healing catch-up dispatch via robin-sync."],
    // Gaps found 2026-05-29 (post-backlog-drain cleanup): "The askrobin.io …",
    // "Sam's Robin <feature>", MCP/DB internals, npm-packaging, VM/infra.
    ['askrobin-vm', 'The askrobin.io VM image ships a read-only root filesystem.'],
    ['askrobin-deploy', 'The askrobin.io web product renders pages on demand.'],
    ['robin-backend', 'mcp__robin__ writes events to SurrealDB and uses a vector index.'],
    ['brief', "Sam's Robin daily briefing includes the forecast, calendar, and weather."],
    ['npm', 'Sam Rivera uses the robin-assistant npm package as his personal AI assistant.'],
    ['design', 'The askrobin.io project uses a two-color palette.'],
    // Robin integration-count artifacts (gap found 2026-06-08). The subject is
    // "Sam" (a legit life-fact subject, so the leading-subject check passes),
    // but the predicate is about the COUNT of Robin's own integrations — machinery.
    ['robin-integration-count', "Sam's test instance has 3 integrations installed."],
    ['robin-integrations-count', "Sam's Robin assistant has 3 active integrations in testing."],
    // Belief-machinery meta-claims: beliefs ABOUT Robin's belief store / churn.
    // (`robin-belief-topic-canonicalization-needed`, minted by brief synthesis.)
    [
      'robin-belief-topic-canonicalization-needed',
      "Multiple 'robin-*' belief topics are accumulating 3+ revisions via writer-conflict; a canonicalization pass would stop them polluting the decision-replay signal.",
    ],
    ['surrealdb-transport', 'SurrealDB was benchmarked over a local socket.'],
  ];
  for (const [topic, claim] of dropped) {
    assert.equal(isLowQualityClaim(topic, claim), true, `"${claim}" should be dropped`);
  }
});

test('isLowQualityClaim: the owner-possessive check follows the configured operator name', () => {
  const claim = "Sam's Robin assistant has a new scheduler.";
  setOperatorProfileForTests({
    name: null,
    context: null,
    aliases: [],
    privateTerms: [],
    home: null,
  });
  try {
    assert.equal(isLowQualityClaim('x', claim), false, 'no name configured → not an owner match');
    setOperatorProfileForTests({
      name: 'Sam',
      context: null,
      aliases: [],
      privateTerms: [],
      home: null,
    });
    assert.equal(isLowQualityClaim('x', claim), true);
    // A configured alias (a handle) counts as the owner too; unconfigured ones don't.
    const aliased = "samr's askrobin instance runs on a VM.";
    assert.equal(isLowQualityClaim('x', aliased), false);
    setOperatorProfileForTests({
      name: 'Sam',
      context: null,
      aliases: ['samr'],
      privateTerms: [],
      home: null,
    });
    assert.equal(isLowQualityClaim('x', aliased), true);
  } finally {
    setOperatorProfileForTests({
      name: 'Sam',
      context: null,
      aliases: [],
      privateTerms: [],
      home: null,
    });
  }
});

test('isLowQualityClaim: drops transient/episodic observations', () => {
  const dropped = [
    'The starter slump resolved on night 3: rise went 20 (1/10) → 25 (1/11).',
    'Proofing fully resolved as of 1/14.',
    'The oven-temp drift continues; recovery dipped by a degree.',
    'A provisional-rescore flag hit the bake log.',
  ];
  for (const claim of dropped) {
    assert.equal(isLowQualityClaim('sourdough', claim), true, `"${claim}" should be dropped`);
  }
});

test('isLowQualityClaim: keeps genuine life facts (incl. tool preferences and arrow routes)', () => {
  const kept = [
    ['home', 'Sam lives in Lakeport, Nebraska.'],
    ['stand-mixer', "Sam's primary stand mixer is the Acme X1."],
    ['health', 'Sam has seasonal allergies managed with antihistamines.'],
    ['garden', 'Sam did not plant tomatoes in 2019.'],
    ['employer', "Sam's role at Acme is Payments Infra."],
    // Durable tool preferences that name dev tech — must NOT be dropped.
    ['pkg', 'Sam prefers pnpm over npm.'],
    ['stack', "Sam's primary tech stack is Elixir and Phoenix."],
    ['deploy', 'Sam deploys his side projects to Vercel.'],
    // Durable patterns that merely use arrows — not transient.
    ['bakery-crawl', 'Sam does bakery crawls (Shop A → Shop B → Shop C).'],
    // False-positive guards: real life-facts whose TOPIC mentions a project but
    // whose SUBJECT is Sam. These MUST survive the cleanup (regression from the
    // 05-29 audit — bulk-retracting by topic prefix would have nuked them).
    ['askrobin-github-username', "Sam's GitHub username is samrivera."],
    ['askrobin-ownership', 'Sam Rivera hosts a weekly board-game night.'],
  ];
  for (const [topic, claim] of kept) {
    assert.equal(isLowQualityClaim(topic, claim), false, `"${claim}" should be kept`);
  }
});

test('insertBeliefCandidate: returns sentinel id -1 for filtered dev-artifact claims', () => {
  const db = freshDb();
  const res = insertBeliefCandidate(db, {
    topic: 'robin-infra',
    claim: 'Robin runs as a launchd daemon on macOS.',
  });
  assert.equal(res.id, -1);
  assert.equal(countPendingCandidates(db), 0);
  closeDb(db);
});

test('belief-candidate: insert normalizes topic and lists as pending', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'Job Role',
    claim: 'Sam works on Payments Infra',
    confidence: 0.8,
  });
  assert.ok(id > 0);
  const pending = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].topic, 'job-role'); // normalized
  assert.equal(pending[0].claim, 'Sam works on Payments Infra');
  assert.equal(pending[0].confidence, 0.8);
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].sourceEventId, null);
  closeDb(db);
});

test('belief-candidate: duplicate pending topic+claim is deduped (returns existing id)', () => {
  const db = freshDb();
  const a = insertBeliefCandidate(db, { topic: 't', claim: 'same claim' });
  const b = insertBeliefCandidate(db, { topic: 'T', claim: 'same claim' }); // case-different topic
  assert.equal(a.id, b.id);
  assert.equal(countPendingCandidates(db), 1);
  closeDb(db);
});

test('belief-candidate: different claim on same topic is a separate candidate', () => {
  const db = freshDb();
  insertBeliefCandidate(db, { topic: 't', claim: 'v1' });
  insertBeliefCandidate(db, { topic: 't', claim: 'v2' });
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('belief-candidate: insert rejects empty topic/claim', () => {
  const db = freshDb();
  assert.throws(() => insertBeliefCandidate(db, { topic: '   ', claim: 'x' }));
  assert.throws(() => insertBeliefCandidate(db, { topic: 't', claim: '   ' }));
  closeDb(db);
});

test('belief-candidate: promote routes through believe() and reflects in recallBelief', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'job-role',
    claim: 'Payments Infra',
    confidence: 0.9,
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);

  // Candidate marked promoted + resolved.
  const all = listBeliefCandidates(db, {});
  assert.equal(all[0].status, 'promoted');
  assert.ok(all[0].resolvedAt);
  assert.equal(countPendingCandidates(db), 0);

  // The promoted claim is now the head belief.
  const head = recallBelief(db, { topic: 'job-role' }) as BeliefRecord;
  assert.ok(head);
  assert.equal(head.claim, 'Payments Infra');
  assert.equal(head.confidence, 0.9);
  closeDb(db);
});

test('belief-candidate: reject marks rejected with no belief written', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, { topic: 't', claim: 'maybe' });
  const res = resolveBeliefCandidate(db, null, id, 'reject', 'not durable');
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  const all = listBeliefCandidates(db, {});
  assert.equal(all[0].status, 'rejected');
  assert.ok(all[0].resolvedAt);
  // No belief.update event was created.
  const beliefs = recallBelief(db, {}) as BeliefRecord[];
  assert.equal(beliefs.length, 0);
  closeDb(db);
});

test('belief-candidate: resolving a non-pending candidate throws', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, { topic: 't', claim: 'x' });
  resolveBeliefCandidate(db, null, id, 'reject');
  assert.throws(() => resolveBeliefCandidate(db, null, id, 'promote'));
  closeDb(db);
});

test('belief-candidate: resolving a missing candidate throws', () => {
  const db = freshDb();
  assert.throws(() => resolveBeliefCandidate(db, null, 9999, 'promote'));
  closeDb(db);
});

test('belief-candidate: countPendingCandidates ignores resolved rows', () => {
  const db = freshDb();
  const a = insertBeliefCandidate(db, { topic: 'a', claim: 'a' });
  insertBeliefCandidate(db, { topic: 'b', claim: 'b' });
  insertBeliefCandidate(db, { topic: 'c', claim: 'c' });
  assert.equal(countPendingCandidates(db), 3);
  resolveBeliefCandidate(db, null, a.id, 'reject');
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates rejects pending older than the window', () => {
  const db = freshDb();
  // Insert with an explicitly-old created_at so we control staleness.
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('old', 'stale claim', 'pending', '2026-05-01 00:00:00')`,
  ).run();
  insertBeliefCandidate(db, { topic: 'fresh', claim: 'recent claim' });

  // Anchor "now" at 2026-05-24; the 14-day cutoff is 2026-05-10, so 'old' expires.
  const now = new Date('2026-05-24T12:00:00Z');
  const n = expireStaleCandidates(db, 14, now);
  assert.equal(n, 1);

  const oldRow = listBeliefCandidates(db, {}).find((c) => c.topic === 'old');
  assert.ok(oldRow);
  assert.equal(oldRow.status, 'rejected');
  assert.ok(oldRow.resolvedAt);
  // Fresh one stays pending.
  assert.equal(countPendingCandidates(db), 1);
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates leaves promoted/rejected rows untouched', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('done', 'already promoted', 'promoted', '2026-01-01 00:00:00')`,
  ).run();
  const now = new Date('2026-05-24T12:00:00Z');
  const n = expireStaleCandidates(db, 14, now);
  assert.equal(n, 0);
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'promoted');
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates respects a custom window', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('weekold', 'claim', 'pending', '2026-05-17 00:00:00')`,
  ).run();
  const now = new Date('2026-05-24T12:00:00Z');
  // 14-day window: 7-day-old row survives.
  assert.equal(expireStaleCandidates(db, 14, now), 0);
  // 3-day window: now it expires.
  assert.equal(expireStaleCandidates(db, 3, now), 1);
  closeDb(db);
});

test('belief-candidate: expireStaleConflicts rejects conflicted older than the window', () => {
  const db = freshDb();
  // A conflicted candidate that has sat unreviewed past the window.
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('stuck', 'contradicts the head', 'conflicted', '2026-04-01 00:00:00')`,
  ).run();
  // A fresh conflicted candidate still inside the review window.
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('recent', 'newly flagged', 'conflicted', '2026-05-20 00:00:00')`,
  ).run();

  // Anchor "now" at 2026-05-24; the 30-day cutoff is 2026-04-24.
  const now = new Date('2026-05-24T12:00:00Z');
  const n = expireStaleConflicts(db, 30, now);
  assert.equal(n, 1);

  const rows = listBeliefCandidates(db, {});
  const stuck = rows.find((c) => c.topic === 'stuck');
  assert.ok(stuck);
  assert.equal(stuck.status, 'rejected');
  assert.equal(stuck.resolvedReason, 'stale-conflict-expiry');
  assert.ok(stuck.resolvedAt);
  // The recent conflict is left for review.
  const recent = rows.find((c) => c.topic === 'recent');
  assert.ok(recent);
  assert.equal(recent.status, 'conflicted');
  closeDb(db);
});

test('belief-candidate: expireStaleConflicts never touches pending or promoted rows', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('p', 'old pending', 'pending', '2026-01-01 00:00:00'),
            ('done', 'old promoted', 'promoted', '2026-01-01 00:00:00')`,
  ).run();
  const now = new Date('2026-05-24T12:00:00Z');
  assert.equal(expireStaleConflicts(db, 30, now), 0);
  const rows = listBeliefCandidates(db, {});
  assert.equal(rows.find((c) => c.topic === 'p')?.status, 'pending');
  assert.equal(rows.find((c) => c.topic === 'done')?.status, 'promoted');
  closeDb(db);
});

// ─── P3 formation gate tests ──────────────────────────────────────────────────

test('belief-candidate P3: insertBeliefCandidate persists and reads back provenance', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'test-topic',
    claim: 'some claim',
    confidence: 0.9,
    provenance: 'first-party',
  });
  const candidates = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, id);
  assert.equal(candidates[0].provenance, 'first-party');
  closeDb(db);
});

test('belief-candidate P3: insertBeliefCandidate stores null provenance when omitted', () => {
  const db = freshDb();
  insertBeliefCandidate(db, { topic: 'no-prov', claim: 'claim without provenance' });
  const candidates = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(candidates[0].provenance, null);
  closeDb(db);
});

test('belief-candidate P3: promoting an external candidate writes NO belief and marks rejected', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'gh-stars',
    claim: 'repo has 1234 stars',
    confidence: 0.99,
    provenance: 'external',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  // Gate should block — actual action is reject, not promote.
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  assert.equal(res.blockedReason, 'external-not-durable');
  // Candidate is marked rejected in the DB.
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'rejected');
  assert.ok(row.resolvedAt);
  // No belief event written.
  const belief = recallBelief(db, { topic: 'gh-stars' });
  assert.equal(belief, null);
  closeDb(db);
});

test('belief-candidate P3: promoting inferred below 0.85 is blocked with blockedReason', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'user-pref',
    claim: 'prefers dark mode',
    confidence: 0.7, // below 0.85 threshold for inferred
    provenance: 'inferred',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  assert.equal(res.blockedReason, 'below-threshold-for-class');
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'rejected');
  const belief = recallBelief(db, { topic: 'user-pref' });
  assert.equal(belief, null);
  closeDb(db);
});

test('belief-candidate P3: promoting inferred at exactly 0.85 succeeds', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'user-pref',
    claim: 'prefers dark mode',
    confidence: 0.85, // exactly at threshold
    provenance: 'inferred',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);
  assert.equal(res.blockedReason, undefined);
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'promoted');
  closeDb(db);
});

test('belief-candidate P3: promoted belief carries the correct provenance tag', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'home-location',
    claim: 'lives in Harbortown County Oregon',
    confidence: 0.95,
    provenance: 'first-party',
  });
  resolveBeliefCandidate(db, null, id, 'promote');
  const belief = recallBelief(db, { topic: 'home-location' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.claim, 'lives in Harbortown County Oregon');
  assert.equal(belief.provenance, 'first-party');
  closeDb(db);
});

test('belief-candidate P3: promoted belief carries the provenance from an inferred candidate', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'work-style',
    claim: 'prefers async communication',
    confidence: 0.9, // above 0.85 inferred threshold
    provenance: 'inferred',
  });
  resolveBeliefCandidate(db, null, id, 'promote');
  const belief = recallBelief(db, { topic: 'work-style' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.provenance, 'inferred');
  closeDb(db);
});

test('belief-candidate P3: null provenance falls back to unknown class (threshold 0.8)', () => {
  const db = freshDb();
  // Below unknown threshold (0.8) — should be blocked
  const { id: lowId } = insertBeliefCandidate(db, {
    topic: 'some-fact',
    claim: 'weak unknown claim',
    confidence: 0.75,
    provenance: null,
  });
  const resLow = resolveBeliefCandidate(db, null, lowId, 'promote');
  assert.equal(resLow.action, 'reject');
  assert.equal(resLow.blockedReason, 'below-threshold-for-class');

  // At/above unknown threshold (0.8) — should promote
  const { id: highId } = insertBeliefCandidate(db, {
    topic: 'some-fact-2',
    claim: 'strong unknown claim',
    confidence: 0.8,
    provenance: null,
  });
  const resHigh = resolveBeliefCandidate(db, null, highId, 'promote');
  assert.equal(resHigh.action, 'promote');
  assert.ok(resHigh.promotedBeliefEventId);
  closeDb(db);
});

test('belief-candidate P3: existing promote test still works with first-party provenance (>= 0.5)', () => {
  // Regression guard: the pre-P3 promote test inserted confidence=0.9 with no
  // provenance, which now falls back to 'unknown' (threshold 0.8). Explicitly
  // set provenance='first-party' here to assert the happy path remains intact.
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'fp-topic',
    claim: 'a first-party claim',
    confidence: 0.6, // above first-party threshold of 0.5
    provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);
  const belief = recallBelief(db, { topic: 'fp-topic' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.provenance, 'first-party');
  closeDb(db);
});

// ─── Domain tagging tests ─────────────────────────────────────────────────────

test('insertBeliefCandidate persists the domain tag', () => {
  const db = freshDb();
  const r = insertBeliefCandidate(db, {
    topic: 'home-location',
    claim: 'Sam lives in Lakeport',
    domain: 'home',
  });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as {
    domain: string | null;
  };
  assert.equal(row.domain, 'home');
  closeDb(db);
});

test('insertBeliefCandidate defaults domain to NULL when omitted', () => {
  const db = freshDb();
  const r = insertBeliefCandidate(db, { topic: 'coffee', claim: 'Sam drinks espresso' });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as {
    domain: string | null;
  };
  assert.equal(row.domain, null);
  closeDb(db);
});

test('insertCandidateWithDedup (no embedder) persists the domain via the exact-match fallback', async () => {
  const db = freshDb();
  const r = await insertCandidateWithDedup(db, null, {
    topic: 'primary-mixer',
    claim: 'Sam bakes with an Acme X1',
    domain: 'creative',
  });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as {
    domain: string | null;
  };
  assert.equal(row.domain, 'creative');
  closeDb(db);
});

// ─── Domain gate (Phase D) ────────────────────────────────────────────────────

test('domain gate: a candidate tagged with a non-personal domain never promotes', () => {
  const db = freshDb();
  const c = insertBeliefCandidate(db, {
    topic: 'biographer-chunk-size',
    claim: 'The chunk size is 20k chars',
    domain: 'engineering',
    confidence: 0.99,
    provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'reject');
  assert.equal(res.blockedReason, 'engineering-not-durable');
  assert.equal(res.promotedBeliefEventId, null);
  closeDb(db);
});

test('domain gate: a NULL-domain candidate is grandfathered — still promotable', () => {
  const db = freshDb();
  const c = insertBeliefCandidate(db, {
    topic: 'home-location',
    claim: 'Sam lives in Lakeport',
    confidence: 0.9,
    provenance: 'first-party', // domain omitted → NULL
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId);
  closeDb(db);
});

test('domain gate: a personal-domain candidate promotes normally', () => {
  const db = freshDb();
  const c = insertBeliefCandidate(db, {
    topic: 'primary-mixer',
    claim: 'Sam bakes with an Acme X1',
    domain: 'creative',
    confidence: 0.9,
    provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId);
  closeDb(db);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatTopicProposals } from '../../surfaces/cli/corrections.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { InvokeResult, LLMProvider } from '../llm/types.ts';
import { believe } from '../memory/belief.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { applyCorrections } from './apply-corrections.ts';
import {
  applyCorrectionTopics,
  mentionedTopics,
  proposeCorrectionTopics,
} from './correction-topics.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-corr-topics-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** classify mock: `respond(prompt)` builds the reply; records every prompt it saw. */
function mockClassify(respond: (prompt: string) => string) {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req): Promise<InvokeResult> => {
      const content = String(req.messages[0]?.content ?? '');
      prompts.push(content);
      return {
        text: respond(content),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('classify', 'mock');
  return { llm: d, prompts };
}

function addCorrection(db: RobinDb, what: string, correction: string, topic?: string): number {
  return Number(
    db
      .prepare('INSERT INTO corrections (what, correction, topic) VALUES (?, ?, ?)')
      .run(what, correction, topic ?? null).lastInsertRowid,
  );
}

function seed(db: RobinDb) {
  believe(db, null, {
    topic: 'book-club-meeting',
    claim: 'The book club meeting is on Thursday evening',
    confidence: 0.8,
  });
  believe(db, null, {
    topic: 'printer-toner',
    claim: 'The office printer takes the 26A toner cartridge',
    confidence: 0.8,
  });
  believe(db, null, {
    topic: 'conflict-bookclub-toner',
    claim: 'Conflict record: book club meeting Thursday Tuesday printer toner cartridge disagree',
    confidence: 0.5,
  });
}

test('mentionedTopics: quoted/backticked slugs and "topic x" phrases', () => {
  assert.deepEqual(
    mentionedTopics("Belief 'garden-plan' (event 1) vs `soil-test` and topic compost-restart"),
    ['garden-plan', 'soil-test', 'compost-restart'],
  );
});

test('proposeCorrectionTopics: candidates are live topics only; conflict-* never offered', async () => {
  const db = freshDb();
  seed(db);
  const id = addCorrection(
    db,
    "Belief 'book-club-meeting' says it is on Thursday",
    'The book club meeting is Tuesday, not Thursday.',
  );
  const { llm, prompts } = mockClassify(
    () => `{"assignments":[{"id":${id},"topic":"book-club-meeting"}]}`,
  );
  const [p] = await proposeCorrectionTopics(db, llm);
  assert.equal(p.correctionId, id);
  assert.equal(p.candidates[0].topic, 'book-club-meeting', 'explicit mention ranks first');
  assert.match(p.candidates[0].claim, /Thursday/, 'candidate carries its current claim');
  assert.ok(!p.candidates.some((c) => c.topic.startsWith('conflict-')));
  assert.equal(p.topic, 'book-club-meeting');
  assert.match(prompts[0], /Correction #\d+/);
  closeDb(db);
});

test('proposeCorrectionTopics: an answer outside the candidate set is discarded', async () => {
  const db = freshDb();
  seed(db);
  const id = addCorrection(
    db,
    'wrong toner model',
    'The office printer takes the 85X toner cartridge.',
  );
  const { llm } = mockClassify(() => `{"assignments":[{"id":${id},"topic":"invented-topic"}]}`);
  const [p] = await proposeCorrectionTopics(db, llm);
  assert.equal(p.topic, null);
  closeDb(db);
});

test('proposeCorrectionTopics: malformed judge output or a thrown call → null, never guessed', async () => {
  const db = freshDb();
  seed(db);
  addCorrection(db, 'wrong toner model', 'The office printer takes the 85X toner cartridge.');
  const { llm } = mockClassify(() => 'sure! printer-toner');
  const [p] = await proposeCorrectionTopics(db, llm);
  assert.equal(p.topic, null);
  closeDb(db);
});

test('proposeCorrectionTopics: skips topic-linked/applied rows and never calls the LLM without candidates', async () => {
  const db = freshDb();
  seed(db);
  addCorrection(db, 'x', 'The book club meeting is Tuesday', 'book-club-meeting'); // already linked
  db.prepare(`INSERT INTO corrections (what, correction, applied) VALUES ('y', 'z', 1)`).run();
  const lonely = addCorrection(db, 'zzqx', 'qqzv wwxy'); // matches no belief at all
  const { llm, prompts } = mockClassify(() => '{"assignments":[]}');
  const out = await proposeCorrectionTopics(db, llm);
  assert.deepEqual(
    out.map((p) => p.correctionId),
    [lonely],
  );
  assert.deepEqual(out[0].candidates, []);
  assert.equal(prompts.length, 0, 'no candidates → no LLM call');
  closeDb(db);
});

test('applyCorrectionTopics + applyCorrections: the linked correction replaces the refuted head', async () => {
  const db = freshDb();
  seed(db);
  const id = addCorrection(
    db,
    "Belief 'book-club-meeting' says Thursday",
    'The book club meeting is Tuesday, not Thursday.',
  );
  const { llm } = mockClassify(() => `{"assignments":[{"id":${id},"topic":"book-club-meeting"}]}`);
  const proposals = await proposeCorrectionTopics(db, llm);

  // A concurrent edit set the topic first → the guarded UPDATE leaves it alone.
  const raced = addCorrection(db, 'r', 'r');
  const racedProposal = { ...proposals[0], correctionId: raced, topic: 'printer-toner' };
  db.prepare(`UPDATE corrections SET topic = 'manual' WHERE id = ?`).run(raced);

  assert.equal(applyCorrectionTopics(db, [...proposals, racedProposal]), 1);
  const row = db.prepare('SELECT topic FROM corrections WHERE id = ?').get(raced) as {
    topic: string;
  };
  assert.equal(row.topic, 'manual');

  const r = applyCorrections(db, null);
  assert.ok(r.processed >= 1);
  const head = db
    .prepare(
      `SELECT c.body FROM events e JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind = 'belief.update' AND json_extract(e.payload,'$.topic') = 'book-club-meeting'
        ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
    )
    .get() as { body: string };
  assert.match(head.body, /Tuesday/);
  closeDb(db);
});

test('formatTopicProposals: dry-run vs apply footer', () => {
  const p = [
    { correctionId: 1, correction: 'a', topic: 't', candidates: [{ topic: 't', claim: '' }] },
    { correctionId: 2, correction: 'b', topic: null, candidates: [] },
  ];
  assert.match(formatTopicProposals(p, null), /Dry run — nothing written/);
  assert.match(formatTopicProposals(p, null), /1 linked, 1 left topic-less/);
  assert.match(formatTopicProposals(p, 1), /Wrote 1 topic/);
});

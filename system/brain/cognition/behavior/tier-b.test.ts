import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { InvokeResult, LLMProvider } from '../../llm/types.ts';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { getSynthesizeCursor } from './cursor.ts';
import { getHabit, insertHabit, listHabits } from './habits-store.ts';
import { runBehaviorSynthesize } from './tier-b.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-tier-b-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a raw lunch_money.transaction event (an allowlisted behavioral signal). */
function insertPurchaseEvent(db: RobinDb, merchant: string, ts: string): number {
  const info = db
    .prepare(
      `INSERT INTO events (ts, kind, source, actor, status, payload)
       VALUES (?, 'lunch_money.transaction', 'lunch_money', 'user', 'ok', ?)`,
    )
    .run(ts, JSON.stringify({ merchant }));
  return Number(info.lastInsertRowid);
}

/** Insert a raw lrc.catalog_summary event (a DIFFERENT stream → for multi-stream tests). */
function insertShootEvent(db: RobinDb, subject: string, ts: string): number {
  const info = db
    .prepare(
      `INSERT INTO events (ts, kind, source, actor, status, payload)
       VALUES (?, 'lrc.catalog_summary', 'lrc', 'user', 'ok', ?)`,
    )
    .run(ts, JSON.stringify({ subject }));
  return Number(info.lastInsertRowid);
}

/**
 * A dispatcher whose `reasoning` role returns a FIXED structured synthesis object and
 * whose `embed` role returns a deterministic per-text vector. `embedFor` maps a substring
 * of the embedded text to a fixed vector so dedup/suppression collisions are controllable;
 * unknown text gets a unique orthogonal-ish vector (no accidental collisions).
 */
function mockDispatcher(opts: {
  structured: unknown;
  costUsd?: number;
  embedFor?: Array<{ match: string; vec: number[] }>;
}): LLMDispatcher {
  const dim = 8;
  let counter = 1;
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning', 'embed']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (): Promise<InvokeResult> => ({
      text: '',
      structured: opts.structured,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: opts.costUsd ?? 0,
      latencyMs: 0,
      provider: 'mock',
    }),
    embed: async (text: string | string[]): Promise<number[][]> => {
      const inputs = Array.isArray(text) ? text : [text];
      return inputs.map((t) => {
        for (const e of opts.embedFor ?? []) {
          if (t.includes(e.match)) return e.vec;
        }
        // Deterministic unique unit-ish vector keyed off a fresh counter slot.
        const v = new Array(dim).fill(0);
        v[counter % dim] = 1;
        v[(counter + 3) % dim] = 0.001 * counter;
        counter++;
        return v;
      });
    },
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('reasoning', 'mock');
  d.assign('embed', 'mock');
  return d;
}

const NOW = new Date('2026-06-17T00:00:00Z');

const EMPTY_SYNTH = { reinforcements: [], newHabits: [], merges: [] };

test('skip on no-LLM (null dispatcher)', async () => {
  const db = freshDb();
  insertPurchaseEvent(db, 'B&H Photo', '2026-06-01 12:00:00');
  const res = await runBehaviorSynthesize(db, null, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(getSynthesizeCursor(db), 0, 'cursor not advanced on skip');
  closeDb(db);
});

test('skip when disabled', async () => {
  const db = freshDb();
  insertPurchaseEvent(db, 'B&H Photo', '2026-06-01 12:00:00');
  const llm = mockDispatcher({ structured: EMPTY_SYNTH });
  const res = await runBehaviorSynthesize(db, llm, { enabled: false, now: NOW });
  assert.equal(res.skipped, true);
  closeDb(db);
});

test('skip on no new staged signals', async () => {
  const db = freshDb();
  // No allowlisted events at all → selectNewSignals returns nothing.
  const llm = mockDispatcher({ structured: EMPTY_SYNTH });
  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.created, 0);
  closeDb(db);
});

test('§7 creation floor: one instance / single stream → NO habit created', async () => {
  const db = freshDb();
  // A single gear purchase → the TC end-to-end intent: one purchase, no habit.
  insertPurchaseEvent(db, 'Nikon TC-1.4x', '2026-06-10 12:00:00');
  const llm = mockDispatcher({
    structured: {
      reinforcements: [],
      // Model proposes a habit but the engine sees only 1 span / 1 stream → floored.
      newHabits: [
        {
          statement: 'tends to buy teleconverters before birding trips',
          domain: 'finance',
          patternKind: 'purchase',
          evidenceEventIds: [1],
          evidenceSummary: 'one TC purchase',
          distinctTimeSpans: 1,
          distinctStreams: 1,
        },
      ],
      merges: [],
    },
  });
  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.skipped, false);
  assert.equal(res.created, 0, 'floored — no habit created from a single instance');
  assert.equal(listHabits(db).length, 0);
  assert.ok(getSynthesizeCursor(db) > 0, 'cursor still advances (signals were seen)');
  closeDb(db);
});

test('§7 creation floor: ≥2 instances across ≥2 streams → habit created', async () => {
  const db = freshDb();
  const e1 = insertPurchaseEvent(db, 'B&H Photo', '2026-03-01 12:00:00');
  const e2 = insertShootEvent(db, 'Death Valley', '2026-04-01 12:00:00');
  const llm = mockDispatcher({
    structured: {
      reinforcements: [],
      newHabits: [
        {
          statement: 'tends to buy camera gear before a planned trip',
          domain: 'finance',
          patternKind: 'purchase',
          evidenceEventIds: [e1, e2],
          evidenceSummary: 'gear buy + a trip shoot across two streams',
          distinctTimeSpans: 2,
          distinctStreams: 2,
        },
      ],
      merges: [],
    },
  });
  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.created, 1, 'cleared the floor → created');
  const habits = listHabits(db, 'soft');
  assert.equal(habits.length, 1);
  assert.equal(habits[0].statement, 'tends to buy camera gear before a planned trip');
  assert.ok(habits[0].confidence > 0, 'engine-owned confidence set');
  assert.ok(habits[0].embedding instanceof Float32Array, 'statement was embedded');
  closeDb(db);
});

test('retired-suppression: a proposal matching a retired pattern is suppressed, not created', async () => {
  const db = freshDb();
  insertPurchaseEvent(db, 'B&H Photo', '2026-03-01 12:00:00');
  insertShootEvent(db, 'Joshua Tree', '2026-04-01 12:00:00');

  // Seed a RETIRED habit with a known embedding; the proposal embeds to the SAME vector.
  const retiredVec = [1, 0, 0, 0, 0, 0, 0, 0];
  insertHabit(db, {
    statement: 'tends to overbuy gear impulsively',
    domain: 'finance',
    patternKind: 'purchase',
    embedding: retiredVec,
    status: 'retired',
  });

  const llm = mockDispatcher({
    structured: {
      reinforcements: [],
      newHabits: [
        {
          statement: 'tends to impulse-buy camera gear',
          domain: 'finance',
          patternKind: 'purchase',
          evidenceEventIds: [1, 2],
          evidenceSummary: 'looks like the vetoed pattern',
          distinctTimeSpans: 2,
          distinctStreams: 2,
        },
      ],
      merges: [],
    },
    // Force the proposal's embedding to collide with the retired vector.
    embedFor: [{ match: 'impulse-buy camera gear', vec: retiredVec }],
  });

  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.suppressed, 1, 'suppressed by retired-match');
  assert.equal(res.created, 0, 'not created');
  assert.equal(listHabits(db, 'soft').length, 0, 'no soft habit added');
  closeDb(db);
});

test('reinforcement bumps an existing habit', async () => {
  const db = freshDb();
  const e1 = insertPurchaseEvent(db, 'B&H Photo', '2026-06-10 12:00:00');
  const existing = insertHabit(db, {
    statement: 'tends to buy camera gear before a planned trip',
    domain: 'finance',
    patternKind: 'purchase',
    confidence: 0.3,
    supportCount: 2,
    supportStreams: 2,
    lastReinforced: '2026-05-01 00:00:00',
  });

  const llm = mockDispatcher({
    structured: {
      reinforcements: [
        { habitId: existing.id, evidenceEventIds: [e1], evidenceSummary: 'another pre-trip buy' },
      ],
      newHabits: [],
      merges: [],
    },
  });

  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.reinforced, 1);
  const h = getHabit(db, existing.id);
  assert.equal(h?.supportCount, 3, 'support_count bumped');
  assert.deepEqual(h?.evidenceEventIds, [e1], 'evidence event appended');
  assert.notEqual(h?.confidence, 0.3, 'confidence recomputed from new state');
  closeDb(db);
});

test('over-budget synthesis discards output (no writes), does not advance cursor', async () => {
  const db = freshDb();
  insertPurchaseEvent(db, 'B&H Photo', '2026-03-01 12:00:00');
  insertShootEvent(db, 'Death Valley', '2026-04-01 12:00:00');
  const llm = mockDispatcher({
    costUsd: 99, // way over the per-run budget
    structured: {
      reinforcements: [],
      newHabits: [
        {
          statement: 'tends to buy gear before trips',
          domain: 'finance',
          patternKind: 'purchase',
          evidenceEventIds: [1, 2],
          evidenceSummary: 'x',
          distinctTimeSpans: 2,
          distinctStreams: 2,
        },
      ],
      merges: [],
    },
  });
  const res = await runBehaviorSynthesize(db, llm, { now: NOW });
  assert.equal(res.created, 0, 'no habit created when over budget');
  assert.equal(listHabits(db).length, 0);
  assert.equal(getSynthesizeCursor(db), 0, 'cursor not advanced — signals re-processed next run');
  closeDb(db);
});

test('graduation pass: a qualifying soft habit graduates + emits a candidate', async () => {
  const db = freshDb();
  // A new signal to clear the skip-on-empty gate (its content is irrelevant here).
  insertShootEvent(db, 'Central Park', '2026-06-16 12:00:00');

  // Soft habit already past the gate: K=4 support, 2 streams, high confidence, ≥3-week
  // window, recently reinforced. Non-sensitive domain (preferences) → may graduate.
  const grad = insertHabit(db, {
    statement: 'tends to shoot most at golden hour',
    domain: 'preferences',
    patternKind: 'temporal',
    confidence: 0.8,
    supportCount: 4,
    supportStreams: 2,
    firstSeen: '2026-05-01 00:00:00',
    lastReinforced: '2026-06-16 00:00:00',
  });

  const llm = mockDispatcher({ structured: EMPTY_SYNTH });
  const res = await runBehaviorSynthesize(db, llm, {
    now: NOW,
    graduationSupport: 4,
    graduationWeeks: 3,
  });
  assert.equal(res.graduated, 1);
  const h = getHabit(db, grad.id);
  assert.equal(h?.status, 'graduated');
  assert.ok((h?.graduatedBeliefId ?? 0) > 0, 'linked to the emitted candidate');
  const cand = db
    .prepare(`SELECT domain, status FROM belief_candidates WHERE id = ?`)
    .get(h?.graduatedBeliefId) as { domain: string; status: string };
  assert.equal(cand.domain, 'preferences');
  assert.equal(cand.status, 'pending');
  closeDb(db);
});

test('graduation guardrail: a sensitive-domain habit never graduates (§11)', async () => {
  const db = freshDb();
  insertShootEvent(db, 'Central Park', '2026-06-16 12:00:00');
  // A finance habit that otherwise CLEARS the gate must stay soft.
  const fin = insertHabit(db, {
    statement: 'tends to move cash to the HYSA after each paycheck',
    domain: 'finance',
    patternKind: 'workflow',
    confidence: 0.9,
    supportCount: 8,
    supportStreams: 2,
    firstSeen: '2026-04-01 00:00:00',
    lastReinforced: '2026-06-16 00:00:00',
  });
  const llm = mockDispatcher({ structured: EMPTY_SYNTH });
  const res = await runBehaviorSynthesize(db, llm, {
    now: NOW,
    graduationSupport: 4,
    graduationWeeks: 3,
  });
  assert.equal(res.graduated, 0, 'finance never auto-graduates');
  assert.equal(getHabit(db, fin.id)?.status, 'soft');
  closeDb(db);
});

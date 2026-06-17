import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import {
  expireRecommendation,
  getRecommendation,
  insertRecommendation,
  listOpenRecommendations,
  listRecommendations,
  resolveRecommendation,
  subjectMatches,
} from './store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('insert + get round-trips all fields and defaults to open/unresolved', () => {
  const db = freshDb();
  // source_event_id is a real FK (foreign_keys = ON), so seed an actual event.
  const src = ingest(db, null, { kind: 'memory.recommendation', source: 'mcp', content: 'rec' });
  const { id } = insertRecommendation(db, {
    subject: 'Nikon Z TC-1.4x',
    claim: 'Buy the TC-1.4x for Z50II birding reach.',
    reasoning: 'near-zero IQ loss; 210-840mm-eq f/8',
    verdict: 'buy',
    domain: 'finance',
    confidence: 0.8,
    sourceEventId: src.eventId,
    expiresAt: '2026-09-15 00:00:00',
  });
  assert.ok(id > 0);

  const r = getRecommendation(db, id);
  assert.ok(r);
  assert.equal(r.subject, 'Nikon Z TC-1.4x');
  assert.equal(r.claim, 'Buy the TC-1.4x for Z50II birding reach.');
  assert.equal(r.reasoning, 'near-zero IQ loss; 210-840mm-eq f/8');
  assert.equal(r.verdict, 'buy');
  assert.equal(r.domain, 'finance');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.sourceEventId, src.eventId);
  assert.equal(r.expiresAt, '2026-09-15 00:00:00');
  assert.equal(r.status, 'open'); // default
  assert.equal(r.outcome, null);
  assert.equal(r.actedAt, null);
  assert.equal(r.actionEventId, null);
  assert.equal(r.evidence, null);
  assert.ok(r.createdAt);
  closeDb(db);
});

test('insert requires a subject and a claim, and clamps confidence', () => {
  const db = freshDb();
  assert.throws(
    () => insertRecommendation(db, { subject: '  ', claim: 'x', domain: 'finance' }),
    /subject required/,
  );
  assert.throws(
    () => insertRecommendation(db, { subject: 'x', claim: '  ', domain: 'finance' }),
    /claim required/,
  );
  const { id } = insertRecommendation(db, {
    subject: 'thing',
    claim: 'advice',
    domain: 'preferences',
    confidence: 5,
  });
  assert.equal(getRecommendation(db, id)?.confidence, 1, 'confidence clamps to 1');
  // Nullable optionals default to null.
  const r = getRecommendation(db, id);
  assert.equal(r?.reasoning, null);
  assert.equal(r?.verdict, null);
  assert.equal(r?.sourceEventId, null);
  assert.equal(r?.expiresAt, null);
  closeDb(db);
});

test('listRecommendations filters by status; listOpenRecommendations returns only open', () => {
  const db = freshDb();
  const a = insertRecommendation(db, { subject: 'a one', claim: 'c', domain: 'creative' });
  const b = insertRecommendation(db, { subject: 'b two', claim: 'c', domain: 'health' });
  const c = insertRecommendation(db, { subject: 'c three', claim: 'c', domain: 'travel' });
  resolveRecommendation(db, c.id, { status: 'declined', outcome: 'not_acted' });

  assert.equal(listRecommendations(db).length, 3); // no filter → all
  const open = listOpenRecommendations(db);
  const openIds = open.map((r) => r.id).sort((x, y) => x - y);
  assert.deepEqual(
    openIds,
    [a.id, b.id].sort((x, y) => x - y),
  );
  assert.equal(listRecommendations(db, { status: 'declined' }).length, 1);
  closeDb(db);
});

test('resolveRecommendation writes status/outcome/acted_at/action_event_id/evidence', () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Nikon Z TC-1.4x',
    claim: 'buy it',
    domain: 'finance',
  });
  // action_event_id is a real FK — seed an actual event to point at.
  const act = ingest(db, null, { kind: 'lunch_money.transaction', source: 'lunch_money' });
  resolveRecommendation(db, id, {
    status: 'acted',
    outcome: 'acted',
    actedAt: '2026-06-17 12:00:00',
    actionEventId: act.eventId,
    evidence: 'linker: purchase signal "Nikon Z TC-1.4x" matched subject',
  });
  const r = getRecommendation(db, id);
  assert.equal(r?.status, 'acted');
  assert.equal(r?.outcome, 'acted');
  assert.equal(r?.actedAt, '2026-06-17 12:00:00');
  assert.equal(r?.actionEventId, act.eventId);
  assert.match(r?.evidence ?? '', /matched subject/);
  closeDb(db);
});

test('resolveRecommendation throws on a missing recommendation', () => {
  const db = freshDb();
  assert.throws(
    () => resolveRecommendation(db, 12345, { status: 'acted', outcome: 'acted' }),
    /not found/,
  );
  closeDb(db);
});

test('expireRecommendation marks it expired/not_acted with an evidence note', () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'some gear',
    claim: 'buy it',
    domain: 'finance',
  });
  expireRecommendation(db, id, '2026-09-20 00:00:00');
  const r = getRecommendation(db, id);
  assert.equal(r?.status, 'expired');
  assert.equal(r?.outcome, 'not_acted');
  assert.equal(r?.actedAt, '2026-09-20 00:00:00');
  assert.match(r?.evidence ?? '', /expired/);
  closeDb(db);
});

test('source_event_id and action_event_id are nulled (not orphaned) when an event is purged', () => {
  const db = freshDb();
  // Seed two real events to point at (FK = ON; ON DELETE SET NULL on both columns).
  const src = ingest(db, null, { kind: 'memory.recommendation', source: 'mcp' });
  const act = ingest(db, null, { kind: 'lunch_money.transaction', source: 'lunch_money' });
  const { id } = insertRecommendation(db, {
    subject: 'thing',
    claim: 'c',
    domain: 'finance',
    sourceEventId: src.eventId,
  });
  resolveRecommendation(db, id, {
    status: 'acted',
    outcome: 'acted',
    actionEventId: act.eventId,
  });

  db.prepare(`DELETE FROM events WHERE id IN (?, ?)`).run(src.eventId, act.eventId);
  const r = getRecommendation(db, id);
  assert.equal(r?.sourceEventId, null, 'source_event_id nulled on event purge');
  assert.equal(r?.actionEventId, null, 'action_event_id nulled on event purge');
  assert.equal(r?.status, 'acted', 'the recommendation row survives the purge');
  closeDb(db);
});

test('subjectMatches: conservative multi-token whole-word match (mirrors Tier A)', () => {
  // Multi-token named entity matches case-insensitively / trimmed.
  assert.ok(subjectMatches('Nikon Z TC-1.4x', '  nikon z tc 1.4x '));
  assert.ok(subjectMatches('bought the Nikon Z TC-1.4x today', 'Nikon Z TC-1.4x'));
  // Single-word object is rejected (too ambiguous — deferred to the LLM path).
  assert.equal(subjectMatches('Nikon Z TC-1.4x', 'Nikon'), false);
  assert.equal(subjectMatches('camera gear', 'gear'), false);
  // Whole-word anchored: a substring that is not a whole-word run does not match.
  assert.equal(subjectMatches('smart watch', 'art watch'), false);
  // Empty object never matches.
  assert.equal(subjectMatches('anything', ''), false);
  // A genuine multi-token mismatch stays unmatched.
  assert.equal(subjectMatches('Nikon Z TC-1.4x', 'Sony 200 600'), false);
});

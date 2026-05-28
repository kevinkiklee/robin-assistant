import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe } from '../memory/belief.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { buildPrimer, writePrimerFile } from './primer.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-primer-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, dir };
}

function addCorrection(
  db: ReturnType<typeof openDb>,
  what: string,
  correction: string,
  context?: string,
) {
  db.prepare(`INSERT INTO corrections (what, correction, context) VALUES (?, ?, ?)`).run(
    what,
    correction,
    context ?? null,
  );
}

function freshProfileDirs() {
  const root = mkdtempSync(join(tmpdir(), 'robin-primer-content-'));
  const profileDir = join(root, 'profile');
  const knowledgeDir = join(root, 'knowledge');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(knowledgeDir, { recursive: true });
  return { profileDir, knowledgeDir };
}

test('buildPrimer: empty DB and no profile dir → empty string', () => {
  const { db } = freshDb();
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.equal(out, '');
  closeDb(db);
});

test('buildPrimer: renders corrections newest-first', () => {
  const { db } = freshDb();
  addCorrection(db, 'pitched high-MP body', 'never pitch high-MP bodies', 'photography');
  addCorrection(db, 'offered /schedule', 'do not offer /schedule unprompted');
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /## Corrections/);
  // ORDER BY ts DESC — equal ts, so rowid DESC: the /schedule rule (inserted 2nd) is newest.
  const schedIdx = out.indexOf('/schedule');
  const mpIdx = out.indexOf('high-MP');
  assert.ok(schedIdx >= 0 && mpIdx >= 0);
  assert.ok(schedIdx < mpIdx, 'newest correction should render first');
  assert.match(out, /\(photography\)/);
  closeDb(db);
});

test('buildPrimer: corrections render the directive only, compact (no "what → " prefix)', () => {
  const { db } = freshDb();
  addCorrection(db, 'pitched high-MP body', 'never pitch high-MP bodies', 'photography');
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  // Compact format: `- <correction> (<context>)`, no `what` text and no arrow.
  assert.match(out, /- never pitch high-MP bodies \(photography\)/);
  assert.doesNotMatch(out, /pitched high-MP body/, 'verbose "what" prefix must be dropped');
  assert.doesNotMatch(out, /→/, 'arrow separator must be dropped');
  closeDb(db);
});

test('buildPrimer: all ~16 short corrections fit — none silently dropped', () => {
  const { db } = freshDb();
  // 16 short behavioral rules; the two most important (oldest) were written first.
  addCorrection(db, 'offered /schedule unprompted', 'never offer /schedule unprompted');
  addCorrection(db, 'over-praised an idea', 'do not over-praise; be measured');
  for (let i = 0; i < 14; i++) {
    addCorrection(db, `mistake ${i}`, `behavioral rule number ${i}`);
  }
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  // The oldest two (most important) rules must survive under the sub-cap.
  assert.match(out, /never offer \/schedule unprompted/);
  assert.match(out, /do not over-praise; be measured/);
  // Every one of the 14 generated rules must also appear — nothing dropped.
  for (let i = 0; i < 14; i++) {
    assert.match(out, new RegExp(`behavioral rule number ${i}\\b`), `rule ${i} should appear`);
  }
  // 16 correction bullet lines total.
  const bulletCount = (out.match(/^- /gm) ?? []).length;
  assert.equal(bulletCount, 16, 'all 16 corrections should render');
  closeDb(db);
});

test('buildPrimer: renders belief heads as topic: claim', () => {
  const { db } = freshDb();
  believe(db, null, { topic: 'google.role', claim: 'Ad Experiences', date: '2026-05-23' });
  believe(db, null, { topic: 'sport', claim: 'plays hockey', date: '2026-05-23' });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /## Beliefs/);
  assert.match(out, /google-role: Ad Experiences/);
  assert.match(out, /sport: plays hockey/);
  closeDb(db);
});

test('buildPrimer: only the belief HEAD is shown after supersession', () => {
  const { db } = freshDb();
  believe(db, null, { topic: 'google.role', claim: 'old role', date: '2026-05-20' });
  believe(db, null, { topic: 'google.role', claim: 'Ad Experiences', date: '2026-05-23' });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /google-role: Ad Experiences/);
  assert.doesNotMatch(out, /old role/);
  closeDb(db);
});

test('buildPrimer: inlines character.md and voice.md', () => {
  const { db } = freshDb();
  const { profileDir, knowledgeDir } = freshProfileDirs();
  writeFileSync(join(profileDir, 'character.md'), '# Character\nDirect, dry wit.');
  writeFileSync(join(profileDir, 'voice.md'), '# Voice\nConcise, no fluff.');
  const out = buildPrimer(db, { profileDir, knowledgeDir });
  assert.match(out, /## character\.md/);
  assert.match(out, /Direct, dry wit\./);
  assert.match(out, /## voice\.md/);
  assert.match(out, /Concise, no fluff\./);
  closeDb(db);
});

test('buildPrimer: indexes other docs without inlining them', () => {
  const { db } = freshDb();
  const { profileDir, knowledgeDir } = freshProfileDirs();
  writeFileSync(join(profileDir, 'character.md'), '# Character\nx');
  writeFileSync(join(profileDir, 'music.md'), '# Music taste\nlikes jazz');
  writeFileSync(join(knowledgeDir, 'nikon-z-lenses.md'), '# Nikon Z lens inventory\nlist');
  const out = buildPrimer(db, { profileDir, knowledgeDir });
  assert.match(out, /## Other docs/);
  assert.match(out, /music\.md — Music taste/);
  assert.match(out, /nikon-z-lenses\.md — Nikon Z lens inventory/);
  // music.md is indexed, not inlined: its body must not appear.
  assert.doesNotMatch(out, /likes jazz/);
  // character.md is inlined and excluded from the index.
  assert.doesNotMatch(out, /character\.md — /);
  closeDb(db);
});

test('buildPrimer: pending candidate count line counts only pending', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, 'pending')`).run(
    'a',
    'b',
  );
  db.prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, 'pending')`).run(
    'c',
    'd',
  );
  db.prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, 'rejected')`).run(
    'e',
    'f',
  );
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /2 candidate beliefs pending review\./);
  closeDb(db);
});

test('buildPrimer: singular phrasing for exactly one pending candidate', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO belief_candidates (topic, claim, status) VALUES (?, ?, 'pending')`).run(
    'a',
    'b',
  );
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /1 candidate belief pending review\./);
  closeDb(db);
});

test('buildPrimer: missing belief_candidates table → no candidate line, no throw', () => {
  // Bare in-memory DB with NO migrations — belief_candidates does not exist. The defensive
  // probe must swallow the SQLITE_ERROR and omit the candidate line entirely.
  const db = openDb(':memory:');
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.doesNotMatch(out, /pending review/);
  assert.equal(out, '');
  closeDb(db);
});

test('buildPrimer: hard cap drops lowest-priority sections first', () => {
  const { db } = freshDb();
  const { profileDir, knowledgeDir } = freshProfileDirs();
  addCorrection(db, 'rule-what', 'rule-correction');
  believe(db, null, { topic: 'belief-topic', claim: 'belief-claim', date: '2026-05-23' });
  writeFileSync(join(profileDir, 'character.md'), '# Character\nprose body here');
  writeFileSync(join(knowledgeDir, 'extra.md'), '# Extra doc title\nbody');

  // Full primer has every section; the corrections-only primer is strictly shorter.
  const full = buildPrimer(db, { profileDir, knowledgeDir });
  assert.match(full, /## Corrections/);
  assert.match(full, /## Beliefs/);
  const correctionsOnlyLen = buildPrimer(db, {
    profileDir,
    knowledgeDir,
    maxChars: 0, // force everything off to measure the smallest section deterministically
  }).length;
  assert.equal(correctionsOnlyLen, 0);

  // Cap that fits Corrections but not the joiner+Beliefs that follows.
  // Compact rendering: the directive only, no "what → " prefix.
  const correctionsSection = '## Corrections (behavioral rules)\n- rule-correction';
  const cap = correctionsSection.length + 1;
  const out = buildPrimer(db, { profileDir, knowledgeDir, maxChars: cap });
  assert.match(out, /## Corrections/);
  assert.ok(out.length <= cap, `expected <= ${cap} chars, got ${out.length}`);
  // Lower-priority sections dropped.
  assert.doesNotMatch(out, /## Beliefs/);
  assert.doesNotMatch(out, /## character\.md/);
  assert.doesNotMatch(out, /## Other docs/);
  closeDb(db);
});

test('buildPrimer: priority order — corrections before beliefs before profile', () => {
  const { db } = freshDb();
  const { profileDir, knowledgeDir } = freshProfileDirs();
  addCorrection(db, 'w', 'c');
  believe(db, null, { topic: 't', claim: 'cl', date: '2026-05-23' });
  writeFileSync(join(profileDir, 'character.md'), '# Character\nbody');
  const out = buildPrimer(db, { profileDir, knowledgeDir });
  const cIdx = out.indexOf('## Corrections');
  const bIdx = out.indexOf('## Beliefs');
  const pIdx = out.indexOf('## character.md');
  assert.ok(cIdx >= 0 && bIdx >= 0 && pIdx >= 0);
  assert.ok(cIdx < bIdx, 'corrections before beliefs');
  assert.ok(bIdx < pIdx, 'beliefs before profile');
  closeDb(db);
});

test('buildPrimer: suspect belief (weak provenance) gets a tag', () => {
  const { db } = freshDb();
  // third-party provenance → WEAK_PROVENANCE → always suspect
  believe(db, null, {
    topic: 'kevin.google.role',
    claim: 'Ad Experiences',
    confidence: 0.6,
    provenance: 'third-party',
    date: '2026-05-23',
  });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  // Should contain the tag indicator characters
  assert.match(out, /kevin-google-role: Ad Experiences/);
  assert.match(out, /third-party/);
  closeDb(db);
});

test('buildPrimer: suspect belief (low effective confidence) gets a tag', () => {
  const { db } = freshDb();
  // inferred with low confidence → eff < SUSPECT_CONFIDENCE_THRESHOLD → suspect
  believe(db, null, {
    topic: 'test.inferred',
    claim: 'some inferred fact',
    confidence: 0.5,
    provenance: 'inferred',
    date: '2026-05-23',
  });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /test-inferred: some inferred fact/);
  // Inferred is WEAK_PROVENANCE so it gets a tag
  assert.match(out, /inferred/);
  closeDb(db);
});

test('buildPrimer: clean first-party belief renders without tag', () => {
  const { db } = freshDb();
  believe(db, null, {
    topic: 'sport',
    claim: 'plays hockey',
    confidence: 0.95,
    provenance: 'first-party',
    date: '2026-05-23',
  });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /sport: plays hockey/);
  // No tag characters (no angle brackets from the suspect tag format)
  assert.doesNotMatch(out, /sport: plays hockey.*⟨/);
  closeDb(db);
});

test('buildPrimer: null confidence + first-party + fresh → no tag', () => {
  const { db } = freshDb();
  // null confidence alone must NOT trigger a tag
  believe(db, null, {
    topic: 'name',
    claim: 'Kevin',
    confidence: undefined, // null confidence
    provenance: 'first-party',
    date: '2026-05-23',
  });
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /name: Kevin/);
  assert.doesNotMatch(out, /name: Kevin.*⟨/);
  closeDb(db);
});

test('writePrimerFile: writes to given path and reports bytes', () => {
  const { db, dir } = freshDb();
  addCorrection(db, 'w', 'c');
  const path = join(dir, 'state', 'primer.md');
  const r = writePrimerFile(db, {
    path,
    profileDir: '/no/such/dir',
    knowledgeDir: '/no/such/dir',
  });
  assert.equal(r.path, path);
  const body = readFileSync(path, 'utf8');
  assert.equal(r.bytes, Buffer.byteLength(body));
  assert.match(body, /## Corrections/);
  closeDb(db);
});

// ── Learning digest in primer tests ────────────────────────────────────────

function seedDigestEvent(db: ReturnType<typeof openDb>) {
  const digest = {
    handlerActivity: [
      { surface: 'autonomous', runs: 5, cost: 4.5, turns: 25, handlers: 'biographer' },
    ],
    predictionsByOutcome: [
      { outcome: 'right', n: 2 },
      { outcome: 'wrong', n: 1 },
    ],
    overallBrier: 0.18,
    openPredictions: { count: 3, nearestDeadline: '2026-05-28T00:00:00.000Z' },
    beliefLifecycle: {
      promoted: 1,
      conflicted: 0,
      merged: 0,
      expired: 0,
      pendingCandidates: 12,
      activeBeliefHeads: 30,
    },
    corrections: { total: 4, behavioral: 3, topicLinked: 1, unapplied: 1 },
    failedRuns: [],
  };
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload)
     VALUES (datetime('now'), 'dream.learning_digest', 'dream', 'ok', ?)`,
  ).run(JSON.stringify({ external_id: 'learning-digest:2026-05-25', digest }));
}

test('buildPrimer: includes learning digest section when digest event exists', () => {
  const { db } = freshDb();
  seedDigestEvent(db);
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.match(out, /## Learning digest/);
  assert.match(out, /Predictions/);
  assert.match(out, /2 right/);
  assert.match(out, /1 wrong/);
  assert.match(out, /Brier: 0\.18/);
  assert.match(out, /Beliefs/);
  assert.match(out, /1 promoted/);
  assert.match(out, /Corrections/);
  closeDb(db);
});

test('buildPrimer: no learning digest section when no digest event exists', () => {
  const { db } = freshDb();
  const out = buildPrimer(db, { profileDir: '/no/such/dir', knowledgeDir: '/no/such/dir' });
  assert.doesNotMatch(out, /Learning digest/);
  closeDb(db);
});

test('buildPrimer: learning digest appears before beliefs (compact, high-signal)', () => {
  const { db } = freshDb();
  const { profileDir, knowledgeDir } = freshProfileDirs();
  believe(db, null, { topic: 't', claim: 'cl', date: '2026-05-23' });
  seedDigestEvent(db);
  writeFileSync(join(profileDir, 'character.md'), '# Character\nbody');
  const out = buildPrimer(db, { profileDir, knowledgeDir });
  const dIdx = out.indexOf('## Learning digest');
  const bIdx = out.indexOf('## Beliefs');
  const pIdx = out.indexOf('## character.md');
  assert.ok(dIdx >= 0 && bIdx >= 0 && pIdx >= 0);
  assert.ok(dIdx < bIdx, 'digest before beliefs (compact, high-priority)');
  assert.ok(bIdx < pIdx, 'beliefs before profile');
  closeDb(db);
});

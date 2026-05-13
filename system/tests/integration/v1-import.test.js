// v1-import.test.js — end-to-end integration test for the v1 → v2 migrator.
//
// Builds a miniature v1 user-data fixture in a temp dir, runs the importer
// against a fresh mem:// SurrealDB, and asserts the resulting row counts +
// idempotency on second-run + rollback.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { rollbackImport, runImport } from '../../runtime/install/v1-import/index.js';

const HOME = join(
  tmpdir(),
  `robin-v1imp-int-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

function buildFixtureUserData() {
  const root = join(tmpdir(), `v1-fixture-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const w = (relPath, content) => {
    const p = join(root, relPath);
    mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    writeFileSync(p, content, 'utf8');
  };

  // INDEX.md sentinel
  w('memory/INDEX.md', '# Memory Index\n');

  // ENTITIES.md canonical-name table
  w(
    'memory/ENTITIES.md',
    [
      '# Entities',
      '',
      '- B&H Photo (B&H, BH Photo) — knowledge/service-providers/bh-photo.md',
      '- Joony (Jake Lee, brother) — profile/people/jake-lee.md',
    ].join('\n'),
  );

  // knowledge/ — one entity per file
  w(
    'memory/knowledge/service-providers/bh-photo.md',
    [
      '---',
      'description: B&H Photo Video — NYC superstore',
      'decay: slow',
      'last_verified: 2026-04-15',
      '---',
      '# B&H Photo',
      '',
      'NYC photography retailer.',
    ].join('\n'),
  );
  w(
    'memory/knowledge/locations/home.md',
    [
      '---',
      'description: Astoria home',
      'decay: immortal',
      '---',
      '# Home — [redacted-address]',
      '',
      'Kevin lives at [redacted-address].',
    ].join('\n'),
  );

  // profile/ facets + people
  w(
    'memory/profile/identity.md',
    [
      '---',
      'description: Kevin identity',
      '---',
      '# Identity',
      '',
      '- **Name:** Kevin K Lee',
      '- **Pronouns:** he/him',
    ].join('\n'),
  );
  w(
    'memory/profile/people/jake-lee.md',
    [
      '---',
      'description: Kevin brother',
      '---',
      '# Jake Lee',
      '',
      "Kevin's younger brother; goes by Joony.",
    ].join('\n'),
  );

  // LINKS.md cross-refs
  w(
    'memory/LINKS.md',
    [
      '| From | To | Context |',
      '|------|----|---------|',
      '| knowledge/locations/home.md | profile/people/jake-lee.md | brother lives nearby |',
    ].join('\n'),
  );

  // streams/journal.md
  w(
    'memory/streams/journal.md',
    [
      '---',
      'description: Journal',
      '---',
      '# Journal',
      '',
      '## 2026-04-30',
      '',
      '- Did a thing',
      '- Did another thing',
      '',
      '## 2026-05-01',
      '',
      '- Day two entry',
    ].join('\n'),
  );

  // self-improvement/{preferences, patterns, corrections}
  w(
    'memory/self-improvement/preferences.md',
    [
      '---',
      'description: Preferences',
      '---',
      '# Preferences',
      '',
      '- Be terse and direct.',
      '- Refer to my brother as Joony.',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/patterns.md',
    [
      '---',
      'description: Patterns',
      '---',
      '# Patterns',
      '',
      '## Late-night sessions',
      '',
      'Kevin tends to work late.',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/corrections.md',
    [
      '---',
      'description: Corrections',
      '---',
      '# Corrections',
      '',
      '### 2026-05-08 — A correction',
      '',
      'Body of the correction.',
    ].join('\n'),
  );

  // quarantine/
  w(
    'memory/quarantine/example.md',
    ['---', 'description: Quarantined', '---', 'A snippet that v1 refused inbound.'].join('\n'),
  );

  // streams/inbox.md — HH:MM headers (regression target for the parser fix)
  w(
    'memory/streams/inbox.md',
    [
      '---',
      'description: Inbox',
      '---',
      '# Inbox',
      '',
      '## 2026-05-08 00:55',
      '',
      '[fact] first inbox entry',
      '',
      '## 2026-05-08 01:00',
      '',
      '[thread] second inbox entry',
    ].join('\n'),
  );

  // streams/log.md — [bracketed] dates
  w(
    'memory/streams/log.md',
    [
      '---',
      'description: Log',
      '---',
      '# Log',
      '',
      '## [2026-04-28] lint | all | issues: 6',
      '',
      '- Contradictions: 0',
    ].join('\n'),
  );

  // self-improvement files previously not imported
  w(
    'memory/self-improvement/communication-style.md',
    [
      '---',
      'description: Communication Style',
      '---',
      '# Communication Style',
      '',
      '- No summaries. Read the diff.',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/threads.md',
    [
      '---',
      'description: Threads',
      '---',
      '# Threads',
      '',
      '- [thread] Recurring pattern A',
      '- [thread] Recurring pattern B',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/domain-confidence.md',
    [
      '---',
      'description: Domain Confidence',
      '---',
      '# Domain Confidence',
      '',
      '| Domain | Confidence |',
      '|--------|------------|',
      '| robin  | high       |',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/learning-queue.md',
    [
      '---',
      'description: Learning Queue',
      '---',
      '# Learning Queue',
      '',
      '### 2026-04-30 — Question 1',
      '- status: open',
    ].join('\n'),
  );
  w(
    'memory/self-improvement/session-handoff.md',
    [
      '---',
      'description: Session Handoff',
      '---',
      '# Session Handoff',
      '',
      '## Session — example',
      'context: example handoff text',
    ].join('\n'),
  );

  // tasks.md — open and completed items
  w(
    'memory/tasks.md',
    [
      '---',
      'description: Tasks',
      '---',
      '# Tasks',
      '',
      '- [ ] Open task A (priority: high)',
      '- [x] Completed task B',
    ].join('\n'),
  );

  // memory.surrealdb-era/ — sibling directory; historical photo-collection records
  w(
    'memory.surrealdb-era/knowledge/photo-collection/audit/2026-05-10-audit-report.md',
    ['# Audit', '', '40 scans surveyed.'].join('\n'),
  );

  // artifacts/ — live working docs (cali-trip packing list shape)
  w('artifacts/cali-trip-2026-packing-list.md', ['# Cali Trip', '', '- [ ] Socks × 8'].join('\n'));

  return root;
}

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('runImport: end-to-end fixture lands expected rows', async () => {
  const db = await fresh();
  const src = buildFixtureUserData();

  const { sessionId, report } = await runImport({
    src,
    db,
    robinHome: HOME,
    embed: 'defer',
  });

  assert.ok(sessionId);
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));

  // entities: bh-photo + home + jake-lee = 3
  const [[ec]] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(ec.n, 3);

  // bh-photo's aliases come from ENTITIES.md
  const [bh] = await db.query("SELECT name, meta FROM entities WHERE type = 'service'").collect();
  assert.equal(bh[0].name, 'B&H Photo');
  assert.ok(Array.isArray(bh[0].meta.aliases));
  assert.deepEqual([...bh[0].meta.aliases].sort(), ['B&H', 'BH Photo']);

  // memos:
  //   2 knowledge (bh-photo + home)
  // + 1 person body (jake-lee)
  // + 1 profile_facet (identity)
  // + 1 pattern (patterns.md)
  // + 1 profile_facet (communication-style)
  // + 1 pattern (threads.md)
  // + 1 knowledge (domain-confidence)
  // + 1 knowledge (learning-queue)
  // + 1 knowledge (session-handoff)
  // + 1 knowledge (tasks.md)
  // + 1 knowledge (memory.surrealdb-era audit)
  // = 12
  const [[mc]] = await db.query('SELECT count() AS n FROM memos GROUP ALL').collect();
  assert.equal(mc.n, 12);

  // events: 2 journal days + 1 correction + 2 inbox entries + 1 log entry = 6
  const [[evc]] = await db.query('SELECT count() AS n FROM events GROUP ALL').collect();
  assert.equal(evc.n, 6);

  // breakdown_events is populated (was a dead field before)
  assert.equal(report.breakdown_events.journal, 2);
  assert.equal(report.breakdown_events.inbox, 2);
  assert.equal(report.breakdown_events.log, 1);
  assert.equal(report.breakdown_events.correction, 1);

  // inbox entries (HH:MM headers) have unique titles preserving the time
  const inboxRows = await db.query("SELECT meta FROM events WHERE source = 'v1-inbox'").collect();
  const inboxTitles = inboxRows[0].map((r) => r.meta.title).sort();
  assert.deepEqual(inboxTitles, ['00:55', '01:00']);

  // log entries ([YYYY-MM-DD] headers) carry the freeform title
  const logRows = await db.query("SELECT meta FROM events WHERE source = 'v1-log'").collect();
  assert.equal(logRows[0][0].meta.title, 'lint | all | issues: 6');

  // communication-style projected onto persona.comm_style
  const [personaComm] = await db.query('SELECT comm_style FROM persona:singleton').collect();
  assert.ok(personaComm[0].comm_style?.['communication-style']);

  // tasks.md imported
  const [taskMemo] = await db
    .query("SELECT content FROM memos WHERE meta.source = 'v1-tasks'")
    .collect();
  assert.match(taskMemo[0].content, /Open task A/);

  // memory.surrealdb-era imported with archived flag
  const [archivedEra] = await db
    .query("SELECT content FROM memos WHERE meta.source = 'memory.surrealdb-era'")
    .collect();
  assert.equal(archivedEra.length, 1);

  // artifacts/ copied to v2 user-data/artifacts/
  const [artifactRow] = await db
    .query(
      "SELECT source_path FROM _v1_imports WHERE kind = 'source_file' AND string::starts_with(source_path, 'artifacts/')",
    )
    .collect();
  assert.ok(artifactRow.length >= 1);

  // imported events must have biographed_at unset (option<datetime> = NONE)
  const [biographed] = await db
    .query('SELECT count() AS n FROM events WHERE biographed_at != NONE GROUP ALL')
    .collect();
  assert.equal(biographed?.[0]?.n ?? 0, 0);

  // rules: 2 from preferences.md
  const [[rc]] = await db.query('SELECT count() AS n FROM rules GROUP ALL').collect();
  assert.equal(rc.n, 2);

  // refusals: 1 from quarantine
  const [[refc]] = await db.query('SELECT count() AS n FROM refusals GROUP ALL').collect();
  assert.equal(refc.n, 1);

  // persona singleton populated with name + pronouns
  const [persona] = await db.query('SELECT name, pronouns FROM persona:singleton').collect();
  assert.equal(persona[0].name, 'Kevin K Lee');
  assert.equal(persona[0].pronouns, 'he/him');

  // about edges: 2 knowledge + 1 person body = 3
  const [[aboutCount]] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'about' GROUP ALL")
    .collect();
  assert.equal(aboutCount.n, 3);

  // mentions edge: 1 from LINKS.md (home memo → jake-lee entity)
  const [[mentionsCount]] = await db
    .query("SELECT count() AS n FROM edges WHERE kind = 'mentions' GROUP ALL")
    .collect();
  assert.equal(mentionsCount.n, 1);

  await close(db);
});

test('runImport: re-run is idempotent (every writer skips)', async () => {
  const db = await fresh();
  const src = buildFixtureUserData();

  await runImport({ src, db, robinHome: HOME, embed: 'defer' });
  const before = await rowCount(db);

  const second = await runImport({ src, db, robinHome: HOME, embed: 'defer' });
  const after = await rowCount(db);

  assert.equal(after.memos, before.memos);
  assert.equal(after.events, before.events);
  assert.equal(after.entities, before.entities);
  assert.equal(after.rules, before.rules);
  assert.equal(second.report.counts.memos, 0);
  assert.equal(second.report.counts.events, 0);
  assert.equal(second.report.counts.rules, 0);
  await close(db);
});

test('rollbackImport: most-recent session deletes its imported rows', async () => {
  const db = await fresh();
  const src = buildFixtureUserData();
  await runImport({ src, db, robinHome: HOME, embed: 'defer' });
  const before = await rowCount(db);
  assert.ok(before.memos > 0);

  const { rolledBack, counts } = await rollbackImport({ db });
  assert.ok(rolledBack);
  assert.ok(counts);

  const after = await rowCount(db);
  assert.equal(after.memos, 0);
  assert.equal(after.events, 0);
  assert.equal(after.entities, 0);
  assert.equal(after.rules, 0);
  await close(db);
});

async function rowCount(db) {
  const tables = ['memos', 'events', 'entities', 'rules', 'refusals', 'edges'];
  const out = {};
  for (const t of tables) {
    const [r] = await db.query(`SELECT count() AS n FROM ${t} GROUP ALL`).collect();
    out[t] = r?.[0]?.n ?? 0;
  }
  return out;
}

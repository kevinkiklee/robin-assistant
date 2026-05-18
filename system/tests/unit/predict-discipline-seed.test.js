// predict-discipline-seed.test.js
//
// Verifies that the predict-discipline authored seed rule is correctly
// installed into the `rules` table, and that the install pass is idempotent.
//
// Run via: pnpm test:file system/tests/unit/predict-discipline-seed.test.js

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { parseFrontmatter, seedRules } from '../../runtime/install/seed-rules.js';

// ─── Shared temp home ───────────────────────────────────────────────────────

const HOME = join(tmpdir(), `robin-seed-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');
const REAL_SKELETON_DIR = resolve(import.meta.dirname, '../../cognition/skeleton/rules');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeTmpRulesDir(files) {
  const dir = join(
    tmpdir(),
    `robin-seed-rules-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

function predictDisciplineFixture(version = 1) {
  return `---
id: predict-discipline
kind: authored_seed
version: ${version}
created_at: 2026-05-17
source: cognition-e1-spec
not_retractable: true
---

# Predict discipline

When stating a falsifiable claim that meets all three conditions:

- (a) resolution time ≤ 30 days,
- (b) evidence will be in Robin's reach (job result, integration data, calendar event, user statement, or an observable system state), AND
- (c) it's not a value judgment (avoids "X is good/bad/better" framings),

silently call \`predict()\` with \`(statement, kind, confidence, expected_resolution_at)\`.

Use \`recall()\` of recent \`confidence_band\` rows (via \`get_calibration\`) to inform \`confidence\`.
`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('parseFrontmatter correctly extracts id, version, and not_retractable', () => {
  const raw = `---
id: predict-discipline
version: 1
not_retractable: true
---

body text
`;
  const { frontmatter, body } = parseFrontmatter(raw);
  assert.equal(frontmatter.id, 'predict-discipline');
  assert.equal(frontmatter.version, 1);
  assert.equal(frontmatter.not_retractable, true);
  assert.match(body.trim(), /^body text/);
});

test('fresh DB: install pass creates predict-discipline rule with correct fields', async () => {
  const dir = makeTmpRulesDir({ 'predict-discipline.md': predictDisciplineFixture(1) });
  const db = await freshDb();
  try {
    const results = await seedRules(db, { dir });
    assert.equal(results.length, 1);
    assert.equal(results[0].ruleId, 'predict-discipline');
    assert.equal(results[0].action, 'created');

    const [rows] = await db
      .query("SELECT * FROM rules WHERE meta.id = 'predict-discipline' LIMIT 1")
      .collect();
    assert.equal(rows.length, 1);
    const rule = rows[0];
    assert.equal(rule.meta.id, 'predict-discipline');
    assert.equal(rule.meta.version, 1);
    assert.equal(rule.meta.not_retractable, true);
    assert.equal(rule.active, true);
    assert.equal(rule.kind, 'behavior');
    assert.equal(rule.priority, 80);
    // Content includes the three conditions
    assert.match(rule.content, /\(a\)/);
    assert.match(rule.content, /\(b\)/);
    assert.match(rule.content, /\(c\)/);
    // Content references calibration
    assert.match(rule.content, /confidence_band|get_calibration/);
  } finally {
    await close(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-run install pass on same version: no duplicate row created (idempotency)', async () => {
  const dir = makeTmpRulesDir({ 'predict-discipline.md': predictDisciplineFixture(1) });
  const db = await freshDb();
  try {
    // First run
    const r1 = await seedRules(db, { dir });
    assert.equal(r1[0].action, 'created');

    // Second run — same skeleton, same version
    const r2 = await seedRules(db, { dir });
    assert.equal(r2[0].action, 'skipped');

    // Confirm only one row exists
    const [rows] = await db
      .query("SELECT * FROM rules WHERE meta.id = 'predict-discipline'")
      .collect();
    assert.equal(rows.length, 1);
  } finally {
    await close(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing rule with older version is updated to skeleton version', async () => {
  const dir = makeTmpRulesDir({ 'predict-discipline.md': predictDisciplineFixture(2) });
  const db = await freshDb();
  try {
    // Seed version 1 first
    const dirV1 = makeTmpRulesDir({ 'predict-discipline.md': predictDisciplineFixture(1) });
    await seedRules(db, { dir: dirV1 });
    rmSync(dirV1, { recursive: true, force: true });

    // Now run with version 2 skeleton
    const r2 = await seedRules(db, { dir });
    assert.equal(r2[0].action, 'updated');

    // Version should be bumped
    const [rows] = await db
      .query("SELECT * FROM rules WHERE meta.id = 'predict-discipline' LIMIT 1")
      .collect();
    assert.equal(rows[0].meta.version, 2);
  } finally {
    await close(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing rule with same version is not touched', async () => {
  const dir = makeTmpRulesDir({ 'predict-discipline.md': predictDisciplineFixture(1) });
  const db = await freshDb();
  try {
    // Seed v1
    await seedRules(db, { dir });

    // Mutate content in DB to simulate user edit
    await db
      .query(
        "UPDATE rules SET content = 'user-edited content' WHERE meta.id = 'predict-discipline'",
      )
      .collect();

    // Re-run with same version — should not overwrite user edit
    const r2 = await seedRules(db, { dir });
    assert.equal(r2[0].action, 'skipped');

    const [rows] = await db
      .query("SELECT * FROM rules WHERE meta.id = 'predict-discipline' LIMIT 1")
      .collect();
    assert.equal(rows[0].content, 'user-edited content');
  } finally {
    await close(db);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real skeleton file: predict-discipline.md has three conditions and calibration self-reference', async () => {
  const db = await freshDb();
  try {
    const results = await seedRules(db, { dir: REAL_SKELETON_DIR });
    // At minimum, predict-discipline must be present
    const pd = results.find((r) => r.ruleId === 'predict-discipline');
    assert.ok(pd, 'predict-discipline rule must be seeded from real skeleton');
    assert.ok(
      pd.action === 'created' || pd.action === 'skipped' || pd.action === 'updated',
      `unexpected action: ${pd.action}`,
    );

    const [rows] = await db
      .query("SELECT * FROM rules WHERE meta.id = 'predict-discipline' LIMIT 1")
      .collect();
    assert.equal(rows.length, 1);
    const rule = rows[0];
    // Three conditions
    assert.match(rule.content, /\(a\)/, 'content must contain condition (a)');
    assert.match(rule.content, /\(b\)/, 'content must contain condition (b)');
    assert.match(rule.content, /\(c\)/, 'content must contain condition (c)');
    // Calibration self-reference
    assert.match(
      rule.content,
      /confidence_band|get_calibration/,
      'content must reference confidence_band or get_calibration',
    );
  } finally {
    await close(db);
  }
});

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunReport } from '../../../scripts/memory/lib/densify-report.js';

const fixturePassResults = {
  prePass0: { stubsCreated: 15 },
  pass1: {
    aliasesAdded: 23,
    typeFlips: 4,
    perFile: [
      { relPath: 'profile/people/jake-lee.md', added: ['Jake Lee'], typeFlipped: true },
      { relPath: 'knowledge/projects/photobot.md', added: ['Photobot'], typeFlipped: false },
    ],
    rejections: [],
  },
  pass2: {
    linksInserted: 86,
    perFile: [
      { relPath: 'knowledge/finance/snapshot.md', linkCount: 12 },
    ],
  },
  pass3: {
    edgesAdded: 64,
    filesModified: 31,
    superHubs: ['kevin'],
    pairsConsidered: 200,
    pairsAfterFilter: 80,
  },
  pass4: { entitiesDelta: 22, linksDelta: 145 },
  lint: {
    missingAliases: ['profile/people/foo.md'],
    typeMismatch: [],
    staleRelated: [],
    ambiguousAliases: [],
    candidateEntities: [{ term: 'X', mentions: 3 }],
  },
};

test('writeRunReport produces markdown + summary.json', () => {
  const ws = mkdtempSync(join(tmpdir(), 'report-test-'));
  try {
    const result = writeRunReport({
      workspaceDir: ws,
      date: '2026-05-02',
      mode: 'apply',
      backupPath: 'user-data/backup/user-data-20260502-1234.tar.gz',
      passes: fixturePassResults,
    });
    const md = readFileSync(result.markdownPath, 'utf-8');
    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8'));

    // Markdown shape
    assert.match(md, /# Densify-wiki run — 2026-05-02/);
    assert.match(md, /## Summary/);
    assert.match(md, /Mode: --apply/);
    assert.match(md, /Backup: user-data\/backup\/user-data-20260502-1234\.tar\.gz/);
    assert.match(md, /## Pass 1 — alias expansion/);
    assert.match(md, /## Pass 3 — related: edges/);
    assert.match(md, /## Lint findings/);
    assert.match(md, /Restore command: npm run restore -- --from user-data\/backup/);

    // JSON schema
    assert.equal(json.date, '2026-05-02');
    assert.equal(json.mode, 'apply');
    assert.equal(json.counts.aliases_added, 23);
    assert.equal(json.counts.related_edges_added, 64);
    assert.equal(json.counts.lint_findings.missing_aliases, 1);
    assert.equal(json.backup_path, 'user-data/backup/user-data-20260502-1234.tar.gz');
    assert.equal(json.exit_code, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('writeRunReport with errors sets exit_code=1 and includes errors section', () => {
  const ws = mkdtempSync(join(tmpdir(), 'report-test-'));
  try {
    const result = writeRunReport({
      workspaceDir: ws,
      date: '2026-05-02',
      mode: 'apply',
      backupPath: null,
      passes: { prePass0: { stubsCreated: 0 } },
      errors: ['Pass 1: simulated failure'],
    });
    const md = readFileSync(result.markdownPath, 'utf-8');
    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8'));
    assert.match(md, /## Errors/);
    assert.match(md, /Pass 1: simulated failure/);
    assert.equal(json.exit_code, 1);
    assert.deepEqual(json.errors, ['Pass 1: simulated failure']);
    assert.equal(json.backup_path, null);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('writeRunReport handles missing pass results gracefully (skipped passes)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'report-test-'));
  try {
    const result = writeRunReport({
      workspaceDir: ws,
      date: '2026-05-02',
      mode: 'dry-run',
      backupPath: null,
      passes: {},
    });
    const json = JSON.parse(readFileSync(result.jsonPath, 'utf-8'));
    assert.equal(json.passes.pre_pass_0, 'skipped');
    assert.equal(json.passes.pass_1, 'skipped');
    assert.equal(json.passes.pass_4, 'skipped');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

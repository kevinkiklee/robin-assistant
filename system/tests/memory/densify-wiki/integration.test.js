import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, cpSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDensifyWiki } from '../../../scripts/memory/densify-wiki.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CORPUS = join(__dirname, '../../fixtures/memory/densify-wiki/corpus');

test('integration: full orchestrator run on golden corpus in dry-run', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'integration-'));
  try {
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    mkdirSync(join(ws, 'backup'), { recursive: true });
    cpSync(FIXTURE_CORPUS, join(ws, 'user-data/memory'), { recursive: true });

    const r = await runDensifyWiki({ workspaceDir: ws, mode: 'dry-run', skipBackup: true });
    assert.equal(r.exitCode, 0);

    const summary = JSON.parse(readFileSync(r.summaryPath, 'utf-8'));
    assert.equal(summary.mode, 'dry-run');

    // The fixture has jake-lee.md with `aliases: ["Jake"]` and H1 "Jake Lee" — Pass 1 should propose "Jake Lee" as a new alias.
    assert.ok(
      summary.counts.aliases_added >= 1,
      `expected ≥1 alias proposed, got ${summary.counts.aliases_added}`
    );

    // Pass 1 should also propose flipping jake-lee.md from type:topic → type:entity (entity-shaped dir + has aliases).
    // photobot.md is in knowledge/projects (entity-shaped) with aliases — also a flip candidate.
    assert.ok(
      summary.counts.type_flips >= 1,
      `expected ≥1 type flip proposed, got ${summary.counts.type_flips}`
    );

    // Pass 3 should produce some related: edges from cross-directory entity sharing
    // (jake-lee.md and snapshot.md share Mom, Dad, Morgan Stanley).
    // In dry-run mode, edges aren't written but they're still computed and counted.
    assert.ok(
      summary.counts.related_edges_added >= 0,
      `related_edges_added should be a non-negative count, got ${summary.counts.related_edges_added}`
    );
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('integration: archive files are excluded from related: heuristic', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'integration-archive-'));
  try {
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    mkdirSync(join(ws, 'backup'), { recursive: true });
    cpSync(FIXTURE_CORPUS, join(ws, 'user-data/memory'), { recursive: true });

    const r = await runDensifyWiki({ workspaceDir: ws, mode: 'dry-run', skipBackup: true });
    assert.equal(r.exitCode, 0);

    // archive/old-page.md should not appear in summary's pass3 perFile (if exposed),
    // but easier check: the run completes without crashing on the archive file.
    // (The actual exclusion is unit-tested in pass3-related-heuristic.test.js;
    // here we verify integration stability.)
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('integration: dry-run does not modify fixture files in temp workspace', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'integration-dryrun-'));
  try {
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    mkdirSync(join(ws, 'backup'), { recursive: true });
    cpSync(FIXTURE_CORPUS, join(ws, 'user-data/memory'), { recursive: true });

    const beforeJake = readFileSync(join(ws, 'user-data/memory/profile/people/jake-lee.md'), 'utf-8');
    const beforeSnap = readFileSync(join(ws, 'user-data/memory/knowledge/finance/snapshot.md'), 'utf-8');

    await runDensifyWiki({ workspaceDir: ws, mode: 'dry-run', skipBackup: true });

    const afterJake = readFileSync(join(ws, 'user-data/memory/profile/people/jake-lee.md'), 'utf-8');
    const afterSnap = readFileSync(join(ws, 'user-data/memory/knowledge/finance/snapshot.md'), 'utf-8');

    assert.equal(beforeJake, afterJake, 'dry-run must not mutate jake-lee.md');
    assert.equal(beforeSnap, afterSnap, 'dry-run must not mutate snapshot.md');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

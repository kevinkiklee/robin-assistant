// E2E scenario: Dream Phase 12.5 surfaces stale synced files into
// `user-data/runtime/state/needs-your-input.md` so the user sees them on
// next session start.
//
// Dream itself is agent-driven; this test exercises the deterministic
// helper Dream invokes (`system/scripts/diagnostics/dream-stale-sync.js`)
// that composes scanFreshness + appendSection.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDreamStaleSync } from '../../../scripts/diagnostics/dream-stale-sync.js';
import { needsInputPath, appendSection, readSections } from '../../../scripts/lib/needs-input.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-stale-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/sync'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/knowledge/health'), { recursive: true });
  return dir;
}

function isoHoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

describe('e2e: Dream stale-sync flag', () => {
  it('appends "Stale sync files" section when sync files are >24h old', () => {
    const ws = workspace();
    writeFileSync(
      join(ws, 'user-data/memory/sync/whoop.md'),
      `---\nlast_synced: ${isoHoursAgo(48)}\n---\nstale body\n`,
    );
    const r = runDreamStaleSync({ workspaceDir: ws });
    assert.equal(r.stale, 1);
    const sections = readSections(ws);
    assert.ok(sections['Stale sync files'], 'Stale sync files section should exist');
    assert.match(sections['Stale sync files'], /whoop\.md/);
    assert.match(sections['Stale sync files'], /48h/);
  });

  it('also catches stale files outside sync/ that declare last_synced (Kevin layout)', () => {
    const ws = workspace();
    // No file under user-data/memory/sync/ — but knowledge file declares last_synced.
    writeFileSync(
      join(ws, 'user-data/memory/knowledge/health/whoop.md'),
      `---\nlast_synced: ${isoHoursAgo(72)}\n---\nstale knowledge body\n`,
    );
    const r = runDreamStaleSync({ workspaceDir: ws });
    assert.equal(r.stale, 1);
    const sections = readSections(ws);
    assert.match(sections['Stale sync files'], /knowledge\/health\/whoop\.md/);
  });

  it('clears the section when nothing is stale', () => {
    const ws = workspace();
    // Pre-populate the section as if a prior cycle wrote it.
    appendSection(ws, 'Stale sync files', '- old stale file\n');
    // Now write only fresh files.
    writeFileSync(
      join(ws, 'user-data/memory/sync/whoop.md'),
      `---\nlast_synced: ${isoHoursAgo(2)}\n---\nfresh body\n`,
    );
    const r = runDreamStaleSync({ workspaceDir: ws });
    assert.equal(r.stale, 0);
    assert.equal(r.cleared, true);
    const sections = readSections(ws);
    assert.ok(!sections['Stale sync files'], 'section should be cleared');
  });

  it('flags missing last_synced under explicit sync roots', () => {
    const ws = workspace();
    writeFileSync(
      join(ws, 'user-data/memory/sync/no-stamp.md'),
      `---\ntype: snapshot\n---\nbody without last_synced\n`,
    );
    const r = runDreamStaleSync({ workspaceDir: ws });
    assert.equal(r.missing, 1);
    const sections = readSections(ws);
    assert.match(sections['Stale sync files'], /Missing `last_synced`/);
    assert.match(sections['Stale sync files'], /no-stamp\.md/);
  });

  it('does not touch other sections in needs-your-input.md', () => {
    const ws = workspace();
    appendSection(ws, 'Action-trust promotion proposals', '- foo\n');
    writeFileSync(
      join(ws, 'user-data/memory/sync/whoop.md'),
      `---\nlast_synced: ${isoHoursAgo(48)}\n---\nstale\n`,
    );
    runDreamStaleSync({ workspaceDir: ws });
    const sections = readSections(ws);
    assert.ok(sections['Action-trust promotion proposals'], 'unrelated section preserved');
    assert.ok(sections['Stale sync files'], 'stale section added');
  });
});

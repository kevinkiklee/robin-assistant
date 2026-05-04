// Unit tests for check-sync-freshness diagnostic.
//
// Verifies the scan classifies a fixture mix of files into
// fresh/stale/missing/unparseable correctly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFreshness } from '../../scripts/diagnostics/check-sync-freshness.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'csf-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  return dir;
}

function writeMd(ws, rel, content) {
  const p = join(ws, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

function isoHoursAgo(h, now = Date.now()) {
  return new Date(now - h * 3600 * 1000).toISOString();
}

describe('check-sync-freshness', () => {
  it('classifies a mix of fresh, stale, missing, and unparseable files', () => {
    const ws = makeWorkspace();
    const now = Date.parse('2026-05-03T12:00:00Z');
    writeMd(
      ws,
      'user-data/memory/sync/whoop.md',
      `---\nlast_synced: ${isoHoursAgo(1, now)}\n---\nfresh body\n`,
    );
    writeMd(
      ws,
      'user-data/memory/sync/nhl.md',
      `---\nlast_synced: ${isoHoursAgo(48, now)}\n---\nstale body\n`,
    );
    writeMd(
      ws,
      'user-data/memory/sync/no-stamp.md',
      `---\ntype: snapshot\n---\nbody without last_synced\n`,
    );
    writeMd(
      ws,
      'user-data/memory/sync/bad-stamp.md',
      `---\nlast_synced: not-a-real-date\n---\nbody\n`,
    );
    // A file outside the scan roots is ignored.
    writeMd(
      ws,
      'user-data/memory/profile/identity.md',
      `---\ntype: profile\n---\nignored\n`,
    );

    const result = scanFreshness({
      workspaceDir: ws,
      roots: ['user-data/memory/sync'],
      maxAgeHours: 24,
      now,
    });

    assert.equal(result.fresh.length, 1);
    assert.equal(result.stale.length, 1);
    assert.equal(result.missing.length, 1);
    assert.equal(result.unparseable.length, 1);
    assert.match(result.fresh[0], /whoop\.md$/);
    assert.match(result.stale[0].path, /nhl\.md$/);
    assert.equal(result.stale[0].age_hours, 48);
    assert.match(result.missing[0], /no-stamp\.md$/);
    assert.match(result.unparseable[0], /bad-stamp\.md$/);
  });

  it('handles missing scan roots gracefully', () => {
    const ws = makeWorkspace();
    const result = scanFreshness({
      workspaceDir: ws,
      roots: ['user-data/memory/sync', 'user-data/runtime/state/sync'],
      maxAgeHours: 24,
    });
    assert.deepEqual(result, { fresh: [], stale: [], missing: [], unparseable: [] });
  });

  it('onlyWithStamp filters out files missing last_synced', () => {
    const ws = makeWorkspace();
    const now = Date.parse('2026-05-03T12:00:00Z');
    writeMd(ws, 'user-data/memory/whoop.md', `---\nlast_synced: ${isoHoursAgo(1, now)}\n---\nbody\n`);
    writeMd(ws, 'user-data/memory/no-stamp.md', `---\ntype: snapshot\n---\nbody\n`);
    const result = scanFreshness({
      workspaceDir: ws,
      roots: ['user-data/memory'],
      maxAgeHours: 24,
      onlyWithStamp: true,
      now,
    });
    assert.equal(result.fresh.length, 1);
    assert.equal(result.missing.length, 0);
  });
});

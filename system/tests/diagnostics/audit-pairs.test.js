// Tests for system/scripts/diagnostics/lib/audit-pairs.js
// Uses small synthetic workspaces (mkdtempSync) — no real user-data touched.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// Dynamic import so we can resolve after file creation
const { generateAuditPairs } = await import(join(REPO_ROOT, 'system', 'scripts', 'diagnostics', 'lib', 'audit-pairs.js'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(files, linksRows = null) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'audit-pairs-test-'));
  const memDir = join(tmpDir, 'user-data', 'memory');
  mkdirSync(memDir, { recursive: true });

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(memDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  if (linksRows !== null) {
    const linksContent = [
      '---',
      'description: Cross-reference graph across memory files — auto-generated, do not edit',
      '---',
      '',
      '| From | To | Context |',
      '|------|----|---------|',
      ...linksRows.map(([from, to, ctx = 'context']) => `| ${from} | ${to} | ${ctx} |`),
      '',
    ].join('\n');
    writeFileSync(join(memDir, 'LINKS.md'), linksContent);
  }

  return tmpDir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Touch a file with a given mtime offset (ms from now, negative = older).
 */
function touchAt(workspaceDir, relPath, offsetMs) {
  const full = join(workspaceDir, 'user-data', 'memory', relPath);
  const d = new Date(Date.now() + offsetMs);
  utimesSync(full, d, d);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateAuditPairs', () => {
  describe('pairs from shared LINKS.md cross-references', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('emits pairs of files that share a common link target', () => {
      ws = makeWorkspace({
        'profile/identity.md': '# Identity\n[home](../knowledge/locations/home.md)',
        'profile/work.md': '# Work\n[home](../knowledge/locations/home.md)',
        'knowledge/locations/home.md': '# Home',
      }, [
        ['profile/identity.md', 'knowledge/locations/home.md', 'home'],
        ['profile/work.md',     'knowledge/locations/home.md', 'home'],
      ]);

      const pairs = generateAuditPairs(ws);
      // Both profile files reference home.md, so they should be paired
      const flat = pairs.map(p => p.join('|'));
      assert.ok(
        flat.some(s => s.includes('profile/identity.md') && s.includes('profile/work.md')),
        `Expected identity/work pair, got: ${JSON.stringify(pairs)}`,
      );
    });
  });

  describe('pairs from same sub-tree files', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('emits pairs for files in the same directory', () => {
      ws = makeWorkspace({
        'knowledge/medical/health.md': '# Health',
        'knowledge/medical/medications.md': '# Meds',
        'knowledge/medical/doctor.md': '# Doctor',
      });
      // No LINKS.md — only same-sub-tree pairing

      const pairs = generateAuditPairs(ws);
      const flat = pairs.map(p => p.join('|'));

      assert.ok(
        flat.some(s => s.includes('knowledge/medical/health.md') && s.includes('knowledge/medical/medications.md')),
        `Expected health/medications pair, got: ${JSON.stringify(pairs)}`,
      );
      assert.ok(
        flat.some(s => s.includes('knowledge/medical/health.md') && s.includes('knowledge/medical/doctor.md')),
        `Expected health/doctor pair, got: ${JSON.stringify(pairs)}`,
      );
      assert.ok(
        flat.some(s => s.includes('knowledge/medical/medications.md') && s.includes('knowledge/medical/doctor.md')),
        `Expected medications/doctor pair, got: ${JSON.stringify(pairs)}`,
      );
    });

    it('does not pair files in different sub-trees without a shared link', () => {
      ws = makeWorkspace({
        'profile/identity.md': '# Identity',
        'knowledge/medical/health.md': '# Health',
      });

      const pairs = generateAuditPairs(ws);
      const flat = pairs.map(p => p.join('|'));
      assert.ok(
        !flat.some(s => s.includes('profile/identity.md') && s.includes('knowledge/medical/health.md')),
        `Should not pair files from different subtrees without shared link`,
      );
    });
  });

  describe('cap respected', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('returns at most maxPairs pairs', () => {
      // Create 10 files in the same sub-tree → C(10,2) = 45 pairs → should be capped
      const files = {};
      for (let i = 1; i <= 10; i++) {
        files[`knowledge/topics/topic-${i}.md`] = `# Topic ${i}`;
      }
      ws = makeWorkspace(files);

      const pairs = generateAuditPairs(ws, { maxPairs: 5 });
      assert.ok(pairs.length <= 5, `Expected ≤5 pairs, got ${pairs.length}`);
    });

    it('returns at most default 20 pairs', () => {
      const files = {};
      for (let i = 1; i <= 20; i++) {
        files[`knowledge/topics/topic-${i}.md`] = `# Topic ${i}`;
      }
      ws = makeWorkspace(files);

      const pairs = generateAuditPairs(ws);
      assert.ok(pairs.length <= 20, `Expected ≤20 pairs, got ${pairs.length}`);
    });
  });

  describe('recency ordering', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('returns most-recently-edited pairs first', () => {
      ws = makeWorkspace({
        'knowledge/old/a.md': '# A',
        'knowledge/old/b.md': '# B',
        'knowledge/recent/x.md': '# X',
        'knowledge/recent/y.md': '# Y',
      });

      // Make old/* older than recent/*
      touchAt(ws, 'knowledge/old/a.md', -1_000_000); // 1000s ago
      touchAt(ws, 'knowledge/old/b.md', -1_000_000);
      touchAt(ws, 'knowledge/recent/x.md', -1000);   // 1s ago
      touchAt(ws, 'knowledge/recent/y.md', -1000);

      const pairs = generateAuditPairs(ws, { maxPairs: 20 });
      assert.ok(pairs.length >= 2, 'Should have at least 2 pairs');

      // Find the positions of recent and old pairs
      const recentIdx = pairs.findIndex(p =>
        p.includes('knowledge/recent/x.md') && p.includes('knowledge/recent/y.md'),
      );
      const oldIdx = pairs.findIndex(p =>
        p.includes('knowledge/old/a.md') && p.includes('knowledge/old/b.md'),
      );

      assert.ok(recentIdx !== -1, 'recent pair should appear');
      assert.ok(oldIdx !== -1, 'old pair should appear');
      assert.ok(recentIdx < oldIdx, `Recent pair (${recentIdx}) should come before old pair (${oldIdx})`);
    });
  });

  describe('graceful degradation — missing LINKS.md', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('falls back to same-sub-tree pairing when LINKS.md is absent', () => {
      ws = makeWorkspace({
        'profile/identity.md': '# Identity',
        'profile/work.md': '# Work',
      });
      // No LINKS.md written

      const pairs = generateAuditPairs(ws);
      const flat = pairs.map(p => p.join('|'));
      assert.ok(
        flat.some(s => s.includes('profile/identity.md') && s.includes('profile/work.md')),
        `Expected identity/work pair from same-sub-tree, got: ${JSON.stringify(pairs)}`,
      );
    });
  });

  describe('workspace with only 1 file → no pairs', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('returns empty array when only one file exists', () => {
      ws = makeWorkspace({
        'profile/identity.md': '# Identity',
      });

      const pairs = generateAuditPairs(ws);
      assert.deepEqual(pairs, [], `Expected [], got ${JSON.stringify(pairs)}`);
    });
  });

  describe('deduplication', () => {
    let ws;
    after(() => ws && cleanup(ws));

    it('does not return duplicate pairs (e.g., [a,b] and [b,a])', () => {
      ws = makeWorkspace({
        'profile/identity.md': '# Identity\n[home](../knowledge/locations/home.md)',
        'knowledge/locations/home.md': '# Home',
        'profile/work.md': '# Work\n[home](../knowledge/locations/home.md)',
      }, [
        ['profile/identity.md', 'knowledge/locations/home.md', 'home'],
        ['profile/work.md',     'knowledge/locations/home.md', 'home'],
      ]);

      const pairs = generateAuditPairs(ws);
      const keys = pairs.map(([a, b]) => [a, b].sort().join('|'));
      const uniqueKeys = new Set(keys);
      assert.equal(keys.length, uniqueKeys.size, `Duplicate pairs found: ${JSON.stringify(pairs)}`);
    });
  });
});

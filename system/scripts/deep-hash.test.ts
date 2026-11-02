import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertDeepHashCoherent } from '../surfaces/mcp/hot-reload.ts';
import { computeDeepHash, SELF_IMPORTED_FILES } from './deep-hash.mjs';

function tmpDistRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-deep-hash-'));
}

function writeFixture(distRoot: string, relPath: string, content: string): void {
  const full = join(distRoot, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A minimal but representative fixture tree: the file the core hot-reload
 * self-imports (+ its generated .d.ts), a sibling MCP file it statically
 * imports instead (real business logic NOT refreshed by the self-import),
 * hot-reload.ts itself, an unrelated deep module, and the extension surface.
 */
function seedFixture(distRoot: string): void {
  writeFixture(distRoot, 'surfaces/mcp/core/server.js', 'server v1');
  writeFixture(distRoot, 'surfaces/mcp/core/server.d.ts', 'declare server v1');
  writeFixture(distRoot, 'surfaces/mcp/core/skill-tool.js', 'skill-tool v1');
  writeFixture(distRoot, 'surfaces/mcp/hot-reload.js', 'hot-reload v1');
  writeFixture(distRoot, 'surfaces/mcp/extension/server.js', 'extension v1');
  writeFixture(distRoot, 'brain/memory/belief.js', 'belief v1');
}

test('computeDeepHash: missing dist root → null', () => {
  const distRoot = join(tmpdir(), `robin-deep-hash-missing-${Date.now()}`);
  assert.equal(computeDeepHash(distRoot, SELF_IMPORTED_FILES), null);
});

test('computeDeepHash: identical fixtures hash identically (determinism)', () => {
  const a = tmpDistRoot();
  const b = tmpDistRoot();
  seedFixture(a);
  seedFixture(b);
  assert.equal(computeDeepHash(a, SELF_IMPORTED_FILES), computeDeepHash(b, SELF_IMPORTED_FILES));
});

test('computeDeepHash: .build-stamp itself is always excluded, regardless of excludeFiles', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, '.build-stamp', 'sha\n2026-01-01T00:00:00.000Z\nsome-deep-hash\n');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.equal(after, before);
});

// ── the exclusion boundary: exactly the self-imported file, nothing more ───

test('computeDeepHash: a change to server.js (the self-imported file) does NOT change the hash', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, 'surfaces/mcp/core/server.js', 'server v2 — changed');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.equal(
    after,
    before,
    'server.js is exactly what the self-import refreshes — must be excluded',
  );
});

test('computeDeepHash: a change to server.d.ts (generated from server.ts, changes in lockstep) does NOT change the hash', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, 'surfaces/mcp/core/server.d.ts', 'declare server v2 — new export');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.equal(
    after,
    before,
    'server.d.ts changes in lockstep with server.ts and must not spuriously trip the guard',
  );
});

test('computeDeepHash: a change to skill-tool.js (statically imported sibling, NOT self-imported) DOES change the hash — the residual gap this fix closes', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, 'surfaces/mcp/core/skill-tool.js', 'skill-tool v2 — real logic change');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.notEqual(
    after,
    before,
    'skill-tool.js is real business logic the self-import never refreshes — must be tracked, ' +
      'not swallowed by an over-broad surfaces/mcp/** exclusion',
  );
});

test('computeDeepHash: a change to hot-reload.js (statically imported, not self-imported) DOES change the hash', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, 'surfaces/mcp/hot-reload.js', 'hot-reload v2');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.notEqual(after, before);
});

test('computeDeepHash: a change to the extension surface (unrelated to core, conservatively included) DOES change the hash', () => {
  const distRoot = tmpDistRoot();
  seedFixture(distRoot);
  const before = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  writeFixture(distRoot, 'surfaces/mcp/extension/server.js', 'extension v2');
  const after = computeDeepHash(distRoot, SELF_IMPORTED_FILES);
  assert.notEqual(after, before);
});

// ── full chain: a real hash change from a real skill-tool change refuses ───
// the swap through assertDeepHashCoherent, the actual guard server.ts calls.

test('regression: a skill-tool-only change produces a different deep hash, and assertDeepHashCoherent refuses to treat the swap as safe', () => {
  const before = tmpDistRoot();
  const after = tmpDistRoot();
  seedFixture(before);
  seedFixture(after);
  // Only skill-tool.js differs between the two trees.
  writeFixture(after, 'surfaces/mcp/core/skill-tool.js', 'skill-tool v2 — real logic change');

  const beforeHash = computeDeepHash(before, SELF_IMPORTED_FILES);
  const afterHash = computeDeepHash(after, SELF_IMPORTED_FILES);
  assert.notEqual(afterHash, beforeHash, 'precondition: the two trees must hash differently');

  assert.throws(
    () => assertDeepHashCoherent(beforeHash, afterHash),
    /deep-module hash mismatch/i,
    'a deep hash that moved because of a skill-tool-only change must refuse the swap, not succeed silently',
  );
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../migrations/0016-backfill-last-verified.js';
import { parseFrontmatter } from '../scripts/lib/memory-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0016-'));
  mkdirSync(join(dir, 'user-data', 'memory', 'profile'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'knowledge', 'movies'), { recursive: true });
  return dir;
}

function writeFile(ws, relPath, content) {
  const full = join(ws, 'user-data', 'memory', relPath);
  writeFileSync(full, content, 'utf-8');
  return full;
}

function readFm(ws, relPath) {
  const full = join(ws, 'user-data', 'memory', relPath);
  const content = readFileSync(full, 'utf-8');
  return parseFrontmatter(content).frontmatter;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('migration metadata', () => {
  assert.equal(id, '0016-backfill-last-verified');
  assert.match(description, /last_verified/i);
});

// ---------------------------------------------------------------------------
// Happy path: file with frontmatter but no last_verified
// ---------------------------------------------------------------------------

test('stamps last_verified when field is absent', async () => {
  const ws = workspace();
  writeFile(
    ws,
    'profile/identity.md',
    `---
description: Identity facts
type: topic
---
# Identity
`,
  );

  await up({ workspaceDir: ws });

  const fm = readFm(ws, 'profile/identity.md');
  assert.ok(fm.last_verified, 'last_verified should be set');
  // Should look like a YYYY-MM-DD date.
  assert.match(fm.last_verified, /^\d{4}-\d{2}-\d{2}$/, 'should be YYYY-MM-DD');
});

// ---------------------------------------------------------------------------
// Idempotent: existing last_verified is preserved
// ---------------------------------------------------------------------------

test('preserves existing last_verified (idempotent)', async () => {
  const ws = workspace();
  writeFile(
    ws,
    'profile/goals.md',
    `---
description: Goals
type: topic
last_verified: 2025-01-15
---
# Goals
`,
  );

  await up({ workspaceDir: ws });

  const fm = readFm(ws, 'profile/goals.md');
  assert.equal(fm.last_verified, '2025-01-15', 'existing value must not change');
});

// ---------------------------------------------------------------------------
// Re-run is a no-op
// ---------------------------------------------------------------------------

test('re-running is a no-op', async () => {
  const ws = workspace();
  writeFile(
    ws,
    'profile/personality.md',
    `---
description: Personality
type: topic
---
# Personality
`,
  );

  await up({ workspaceDir: ws });
  const afterFirst = readFm(ws, 'profile/personality.md');

  await up({ workspaceDir: ws });
  const afterSecond = readFm(ws, 'profile/personality.md');

  assert.equal(afterSecond.last_verified, afterFirst.last_verified, 'second run must not change value');
});

// ---------------------------------------------------------------------------
// File with no frontmatter — skip with warning, do not crash
// ---------------------------------------------------------------------------

test('skips file with no frontmatter block', async () => {
  const ws = workspace();
  const content = '# Just a heading\n\nNo frontmatter at all.\n';
  writeFile(ws, 'profile/orphan.md', content);

  // Should not throw.
  await up({ workspaceDir: ws });

  // Content unchanged.
  const full = join(ws, 'user-data', 'memory', 'profile', 'orphan.md');
  assert.equal(readFileSync(full, 'utf-8'), content);
});

// ---------------------------------------------------------------------------
// Fallback to mtime when git unavailable (use a temp dir not in git)
// ---------------------------------------------------------------------------

test('falls back to mtime when git history unavailable', async () => {
  const ws = workspace();
  const fileFull = join(ws, 'user-data', 'memory', 'profile', 'work.md');
  writeFileSync(
    fileFull,
    `---
description: Work info
type: topic
---
# Work
`,
    'utf-8',
  );

  // Set a known mtime (2023-06-15 UTC).
  const knownMtime = new Date('2023-06-15T12:00:00.000Z');
  utimesSync(fileFull, knownMtime, knownMtime);

  // Run in a workspaceDir that is definitely not a git repo by passing a
  // bogus gitRoot via override — we rely on the fact that ws (tmp dir) is
  // not a git repo, so git log will fail and we fall back to mtime.
  await up({ workspaceDir: ws });

  const fm = readFm(ws, 'profile/work.md');
  assert.ok(fm.last_verified, 'last_verified should be set even without git');
  assert.match(fm.last_verified, /^\d{4}-\d{2}-\d{2}$/, 'should be YYYY-MM-DD');
  // mtime is 2023-06-15 in UTC; local conversion may differ by ±1 day.
  // Just check year and month to be resilient.
  assert.match(fm.last_verified, /^2023-06/, 'should reflect the known mtime (2023-06)');
});

// ---------------------------------------------------------------------------
// Multiple files — all stamped in one run
// ---------------------------------------------------------------------------

test('stamps multiple files in one run', async () => {
  const ws = workspace();
  for (const name of ['a.md', 'b.md', 'c.md']) {
    writeFile(
      ws,
      `profile/${name}`,
      `---
description: File ${name}
type: topic
---
# ${name}
`,
    );
  }

  await up({ workspaceDir: ws });

  for (const name of ['a.md', 'b.md', 'c.md']) {
    const fm = readFm(ws, `profile/${name}`);
    assert.ok(fm.last_verified, `${name} should have last_verified`);
  }
});

// ---------------------------------------------------------------------------
// Existing other frontmatter fields are preserved
// ---------------------------------------------------------------------------

test('preserves existing frontmatter fields when stamping', async () => {
  const ws = workspace();
  writeFile(
    ws,
    'profile/interests.md',
    `---
description: Interests
type: topic
custom_field: keep-me
---
# Interests
`,
  );

  await up({ workspaceDir: ws });

  const fm = readFm(ws, 'profile/interests.md');
  assert.equal(fm.description, 'Interests', 'description preserved');
  assert.equal(fm.type, 'topic', 'type preserved');
  assert.equal(fm.custom_field, 'keep-me', 'custom_field preserved');
  assert.ok(fm.last_verified, 'last_verified added');
});

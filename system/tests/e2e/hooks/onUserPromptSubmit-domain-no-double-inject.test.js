// e2e: when prompt matches BOTH an entity alias AND a domain keyword, and
// both pass to the same memory file, the file is injected once (not twice).
//
// Setup: an entity "Astoria" with file knowledge/home/outdoor-space.md AND a
// domain "gardening" mapping to the same file. Prompt "Astoria garden plans"
// triggers both passes; expect the file body to appear once across the
// emitted blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'dr-dup-'));
  mkdirSync(join(ws, 'user-data/memory/knowledge/home'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  return ws;
}

test('file matched by both entity and domain recall is injected once', () => {
  const ws = makeWorkspace();
  // Entity index — "Astoria" maps to outdoor-space.md.
  writeFileSync(
    join(ws, 'user-data/memory/ENTITIES.md'),
    [
      '---',
      'description: Auto-generated entity index',
      'type: reference',
      '---',
      '# Entities',
      '',
      '- Astoria — knowledge/home/outdoor-space.md',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
    '---\ntype: entity\n---\n# Astoria\nrooftop UNIQUE_MARKER_X garden in Astoria\n',
  );
  // Domain map — "garden" → same file.
  writeFileSync(
    join(ws, 'user-data/runtime/config/recall-domains.md'),
    `## gardening\nkeywords: garden, fertilizer\nfiles:\n  - user-data/memory/knowledge/home/outdoor-space.md\n`,
  );

  const event = JSON.stringify({
    session_id: 'dr-dup-1',
    user_message: 'Astoria garden plans for spring',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  // The unique file body marker should appear at most once across all
  // injected blocks (entity recall hits a line with UNIQUE_MARKER_X; domain
  // recall would inject the whole file again — but dedup should prevent that).
  const occurrences = (out.match(/UNIQUE_MARKER_X/g) || []).length;
  assert.equal(occurrences, 1, `expected file body marker once, got ${occurrences} times. out=${out}`);

  // Entity block was emitted.
  assert.match(out, /<!-- relevant memory: \d+ hits for Astoria -->/);
  // Domain block should NOT be emitted because the only mapped file was
  // already covered by entity recall.
  assert.doesNotMatch(out, /domain match/);
});

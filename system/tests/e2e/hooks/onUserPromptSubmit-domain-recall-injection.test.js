// e2e: onUserPromptSubmit injects domain-recall files when prompt matches
// a keyword in user-data/runtime/config/recall-domains.md.
//
// Specifically: prompt mentions "fertilizer" → gardening domain matches →
// outdoor-space.md content shows up in the injected `<!-- relevant memory -->`
// block.

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
  const ws = mkdtempSync(join(tmpdir(), 'dr-e2e-'));
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory/knowledge/home'), { recursive: true });
  // Stub bin/robin.js so workspace-root validates.
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  // Empty ENTITIES.md so entity recall is a no-op.
  writeFileSync(
    join(ws, 'user-data/memory/ENTITIES.md'),
    '---\ndescription: empty\ntype: reference\n---\n# Entities\n',
  );
  return ws;
}

test('domain match injects mapped file as <!-- relevant memory --> block', () => {
  const ws = makeWorkspace();
  writeFileSync(
    join(ws, 'user-data/runtime/config/recall-domains.md'),
    `## gardening\nkeywords: garden, fertilizer, mulch\nfiles:\n  - user-data/memory/knowledge/home/outdoor-space.md\n`,
  );
  writeFileSync(
    join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
    '---\ntype: knowledge\n---\n# Outdoor space\n\nrooftop garden, sunflowers + wildflowers in containers\n',
  );

  const event = JSON.stringify({
    session_id: 'dr-1',
    user_message: 'what fertilizer should I use this spring?',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  assert.match(out, /<!-- relevant memory: 1 files for domain match: gardening -->/);
  assert.match(out, /sunflowers \+ wildflowers/);
  assert.match(out, /<!-- \/relevant memory -->/);
});

test('no domain match → no domain block emitted', () => {
  const ws = makeWorkspace();
  writeFileSync(
    join(ws, 'user-data/runtime/config/recall-domains.md'),
    `## gardening\nkeywords: garden, fertilizer\nfiles:\n  - user-data/memory/knowledge/home/outdoor-space.md\n`,
  );
  writeFileSync(
    join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
    '# Outdoor space\nrooftop\n',
  );
  const event = JSON.stringify({
    session_id: 'dr-2',
    user_message: 'what is the capital of France?',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );
  assert.doesNotMatch(out, /domain match/);
});

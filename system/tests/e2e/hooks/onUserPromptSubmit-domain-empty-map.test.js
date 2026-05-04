// e2e: when recall-domains.md is missing or empty, entity recall still
// fires normally and the hook does not crash.

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
  const ws = mkdtempSync(join(tmpdir(), 'dr-empty-'));
  mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
  mkdirSync(join(ws, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
  writeFileSync(
    join(ws, 'user-data/memory/ENTITIES.md'),
    [
      '---',
      'description: entities',
      'type: reference',
      '---',
      '# Entities',
      '',
      '- Alice — profile/people/alice.md',
      '',
    ].join('\n'),
  );
  mkdirSync(join(ws, 'user-data/memory/profile/people'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/memory/profile/people/alice.md'),
    '---\ntype: entity\n---\n# Alice\nAlice has a dog.\n',
  );
  return ws;
}

test('missing recall-domains.md → entity recall still fires; hook exits 0', () => {
  const ws = makeWorkspace();
  // No recall-domains.md written.
  const event = JSON.stringify({
    session_id: 'em-1',
    user_message: 'tell me about Alice',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );
  assert.match(out, /<!-- relevant memory: \d+ hits for Alice -->/);
  assert.doesNotMatch(out, /domain match/);
});

test('empty recall-domains.md → no crash, no domain block', () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), '');
  const event = JSON.stringify({
    session_id: 'em-2',
    user_message: 'tell me about Alice',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );
  assert.match(out, /<!-- relevant memory: \d+ hits for Alice -->/);
  assert.doesNotMatch(out, /domain match/);
});

test('malformed recall-domains.md → fail-open, entity recall still fires', () => {
  const ws = makeWorkspace();
  writeFileSync(
    join(ws, 'user-data/runtime/config/recall-domains.md'),
    'this is not a valid map\n## but-no-keywords\n',
  );
  const event = JSON.stringify({
    session_id: 'em-3',
    user_message: 'tell me about Alice',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );
  assert.match(out, /<!-- relevant memory: \d+ hits for Alice -->/);
});

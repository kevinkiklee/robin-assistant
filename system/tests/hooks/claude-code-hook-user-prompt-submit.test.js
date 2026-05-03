// Tests for the Claude Code lifecycle hook handler — --on-user-prompt-submit mode.
//
// Scans the user message for known entities (from ENTITIES.md) and injects
// matching memory bullets as a `<!-- relevant memory -->` HTML-comment
// preface to the prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

// Build a minimal tmp workspace with ENTITIES.md + the listed topic files,
// suitable for exercising --on-user-prompt-submit recall behavior.
function makeWorkspaceWithEntities(entities) {
  const ws = mkdtempSync(join(tmpdir(), 'hook-recall-'));
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  const entityLines = ['---', 'description: Auto-generated entity index for fast recall lookup', 'type: reference', '---', '# Entities', ''];
  for (const e of entities) {
    entityLines.push(`- ${e.name} — ${e.file}`);
    const full = join(ws, 'user-data/memory', e.file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `---\ntype: entity\n---\n# ${e.name}\n\n${e.body}\n`);
  }
  writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'), entityLines.join('\n') + '\n');
  return ws;
}

test('UserPromptSubmit caps recall hits at 3 and uses new preface format', () => {
  const ws = makeWorkspaceWithEntities([
    {
      name: 'Alice',
      file: 'profile/relationships.md',
      body: 'Alice likes coffee.\nAlice lives in NYC.\nAlice works at Acme.\nAlice has a dog.\nAlice runs marathons.',
    },
  ]);
  const event = JSON.stringify({
    session_id: 'test',
    user_message: 'tell me about Alice',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  // Preface format: <!-- relevant memory: <N> hits for <entity1>, <entity2> -->
  assert.match(out, /<!-- relevant memory: \d+ hits for Alice -->/);
  // Cap of 3: fixture has 5 matchable Alice lines, recall emits one bullet per hit,
  // so with the cap working we should get exactly 3 — not 0, not 1, not 5.
  const inner = out.split('<!-- relevant memory:')[1]?.split('<!-- /relevant memory -->')[0] ?? '';
  const hitLines = inner.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(hitLines.length, 3, `expected exactly 3 hit lines, got ${hitLines.length}`);
});

test('UserPromptSubmit sanitizes "-->" in entity names so preface comment cannot break out', () => {
  const ws = makeWorkspaceWithEntities([
    {
      name: 'Bad-->Name',
      file: 'profile/relationships.md',
      body: 'Bad-->Name appeared in a log line.',
    },
  ]);
  const event = JSON.stringify({
    session_id: 'test',
    user_message: 'tell me about Bad-->Name',
    transcript_path: '',
  });
  const out = execFileSync(
    'node',
    [HOOK, '--on-user-prompt-submit', '--workspace', ws],
    { input: event, encoding: 'utf8' },
  );

  // The preface line itself must not contain "-->" before the closing "-->" of the comment.
  // Match the preface line and ensure its body uses "->" not "-->".
  const prefaceMatch = out.match(/<!-- relevant memory: \d+ hits for ([^\n]*?) -->/);
  assert.ok(prefaceMatch, `expected preface in output, got: ${out}`);
  assert.ok(!prefaceMatch[1].includes('-->'), `entity-name segment leaked "-->" into comment: ${prefaceMatch[1]}`);
  assert.match(prefaceMatch[1], /Bad->Name/);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { __resetAutoRecallCache, composeAutoRecall } from './auto-recall.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function makeEnv() {
  const userData = mkdtempSync(join(tmpdir(), 'robin-autorecall-'));
  mkdirSync(join(userData, 'config'), { recursive: true });
  mkdirSync(join(userData, 'content', 'knowledge'), { recursive: true });
  mkdirSync(join(userData, 'state', 'db'), { recursive: true });
  const db = openDb(join(userData, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { userData, db };
}

function writeYaml(userData: string, body: string) {
  writeFileSync(join(userData, 'config', 'recall-topics.yaml'), body);
}
function writeDoc(userData: string, rel: string, body: string) {
  writeFileSync(join(userData, rel), body);
}

const PHOTO_YAML = `topics:
  - id: photography
    match: [camera, lens, photo]
    docs: [content/knowledge/gear.md]
`;

test('composeAutoRecall: injects the canonical doc when a topic matches', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/gear.md', '# Gear\nNikon Zf, Viltrox 85mm f/2');
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'what camera should I bring tonight',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  assert.match(out, /Viltrox 85mm/);
  assert.match(out, /auto-recalled/);
  closeDb(db);
});

test('composeAutoRecall: returns null when no topic matches and recall is empty', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'tell me about the weather today please',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: a coding prompt with no topic match yields nothing', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'refactor the typescript build pipeline today',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: gates out short prompts even when they would match', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/gear.md', 'gear');
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'camera?', userData });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: gates out slash commands', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/gear.md', 'gear');
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: '/camera settings explained',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: injects a whole doc at most once per session', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/gear.md', '# Gear\nNikon Zf');
  writeYaml(userData, PHOTO_YAML);

  const sid = 'sess-dedup';
  const first = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which camera tonight please',
    sessionId: sid,
    userData,
  });
  assert.ok(first && /Nikon Zf/.test(first));

  const second = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'and which camera for daytime',
    sessionId: sid,
    userData,
  });
  // Doc already injected this session; no snippets on an empty DB → nothing left.
  assert.equal(second, null);
  closeDb(db);
});

test('composeAutoRecall: injects a large canonical doc whole, never truncated', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  const big = `UNIQUE_HEAD ${'A'.repeat(15000)} UNIQUE_TAIL`;
  writeDoc(userData, 'content/knowledge/gear.md', big);
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'camera advice please', userData });
  assert.ok(out);
  // Both ends present → the whole doc was injected, nothing cut from the middle/tail.
  assert.match(out, /UNIQUE_HEAD/);
  assert.match(out, /UNIQUE_TAIL/);
  assert.doesNotMatch(out, /truncated/);
  assert.ok(out.length > 15000, 'the full doc must be present, not truncated');
  closeDb(db);
});

test('composeAutoRecall: skips a topic whose doc file is missing', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(
    userData,
    `topics:
  - id: photography
    match: [camera]
    docs: [content/knowledge/missing.md]
`,
  );

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'camera recommendation please',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: reads the live doc content, not a cached copy', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/gear.md', 'first version of the gear list');
  writeYaml(userData, PHOTO_YAML);

  const a = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'camera question number one',
    sessionId: 's-a',
    userData,
  });
  assert.ok(a && /first version/.test(a));

  // Edit the live file; a new session must see the new content.
  writeDoc(userData, 'content/knowledge/gear.md', 'second version of the gear list');
  const b = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'camera question number two',
    sessionId: 's-b',
    userData,
  });
  assert.ok(b && /second version/.test(b));
  closeDb(db);
});

test('composeAutoRecall: keeps at most 4 recall snippets', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // A topic map that matches nothing in the prompt, so every injected entry is a snippet.
  writeYaml(
    userData,
    `topics:
  - id: unrelated
    match: [zzzznomatch]
    docs: [content/knowledge/none.md]
`,
  );
  for (let i = 0; i < 6; i++) {
    ingest(db, null, {
      kind: 'session.captured',
      source: 's',
      content: `lisbon photos trip number ${i}`,
    });
  }

  // lex FTS requires all query tokens present in a row; keep the prompt to shared tokens.
  const out = await composeAutoRecall({ db, llm: null, prompt: 'lisbon photos trip', userData });
  assert.ok(out, 'expected snippet injections');
  const snippetLines = out.split('\n').filter((l) => l.startsWith('— '));
  assert.ok(snippetLines.length <= 4, `expected ≤4 snippet lines, got ${snippetLines.length}`);
  assert.ok(snippetLines.length >= 1, 'expected at least one snippet');
  closeDb(db);
});

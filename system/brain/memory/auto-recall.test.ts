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

test('composeAutoRecall: slices an oversized canonical doc to the prompt-relevant section', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // Two large, off-topic sections framing one short relevant section. The whole doc is far
  // over the inline budget, so the harness would otherwise persist it and show only a
  // top-of-doc prefix — exactly the failure that hid the Voigtländer line.
  const filler = 'Q'.repeat(6000);
  const doc = [
    '# Gear',
    '',
    '## Bodies',
    `Nikon Zf body notes. ${filler}`,
    '',
    '## Lenses',
    'Voigtländer 35mm f/2 APO-Lanthar — manual zone-focus lens, engraved DOF scale, hard infinity stop.',
    '',
    '## Accessories',
    `Peak Design straps. ${filler}`,
  ].join('\n');
  writeDoc(userData, 'content/knowledge/gear.md', doc);
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'what is my manual zone-focus lens and its focus scale',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  // The relevant section surfaced...
  assert.match(out, /Voigtländer 35mm f\/2 APO-Lanthar/);
  assert.match(out, /zone-focus/);
  // ...the off-topic filler did NOT crowd the block out of the inline budget...
  assert.doesNotMatch(out, /QQQQQ/);
  // ...the model is told it's a slice and where the full doc lives...
  assert.match(out, /full doc on disk: content\/knowledge\/gear\.md/);
  // ...and the whole block stays inline-sized.
  assert.ok(out.length < 6000, `expected a bounded block, got ${out.length}`);
  closeDb(db);
});

test('composeAutoRecall: hard-caps an oversized structureless doc and points to the file', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // No H2 structure → nothing to slice to; the cap is the only thing keeping it inline.
  writeDoc(userData, 'content/knowledge/gear.md', `HEAD ${'A'.repeat(15000)} TAIL`);
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'camera advice please', userData });
  assert.ok(out);
  assert.match(out, /HEAD/); // top retained
  assert.doesNotMatch(out, /TAIL/); // tail dropped by the cap
  assert.match(out, /full doc on disk: content\/knowledge\/gear\.md/);
  assert.ok(out.length < 6000, `expected a bounded block, got ${out.length}`);
  closeDb(db);
});

test('composeAutoRecall: injects a small canonical doc whole, never sliced', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  const doc = '# Gear\n\n## Bodies\nNikon Zf\n\n## Lenses\nViltrox 85mm f/2, Nikon 26mm f/2.8';
  writeDoc(userData, 'content/knowledge/gear.md', doc);
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'which lens for tonight', userData });
  assert.ok(out);
  // Under budget → both sections present, no slice marker.
  assert.match(out, /Nikon Zf/);
  assert.match(out, /Viltrox 85mm/);
  assert.doesNotMatch(out, /full doc on disk/);
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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { insertHabit } from '../cognition/behavior/habits-store.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
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

/**
 * Mock dispatcher whose `embed` always returns FIXED_VEC. Used for the habit-injection
 * wire: the turn-query embeds to FIXED_VEC, and habits embedded with FIXED_VEC land at
 * cosine 1.0 (always above the relevance floor). Content here is ingested with a null
 * dispatcher (no stored vectors), so `events_vec` is empty and the factual recall path
 * stays lex-only — identical to the `llm: null` tests above.
 */
const FIXED_VEC = [1, 0, 0, 0];
function mockLLM(vec: number[] = FIXED_VEC): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('mock provider has no invoke');
    },
    embed: async () => [vec],
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return d;
}

function writePolicies(userData: string, body: string) {
  writeFileSync(join(userData, 'config', 'policies.yaml'), body);
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

test('composeAutoRecall: an oversized doc can surface two relevant sections', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // A spanning question ("street AND astro") should pull BOTH lens sections, not just the
  // single best — while the unrelated filler section stays out of the inline budget.
  const filler = 'Q'.repeat(6000);
  const doc = [
    '# Gear',
    '',
    '## Street Lenses',
    'Voigtländer 35mm f/2 APO-Lanthar — manual zone-focus lens, engraved DOF scale.',
    '',
    '## Filler',
    filler,
    '',
    '## Astro Lenses',
    'Nikon 20mm f/1.8 S — fast wide for deep-space astrophotography at night.',
  ].join('\n');
  writeDoc(userData, 'content/knowledge/gear.md', doc);
  writeYaml(userData, PHOTO_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which lens for street and which lens for astro at night',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  assert.match(out, /Voigtländer 35mm f\/2 APO-Lanthar/);
  assert.match(out, /Nikon 20mm f\/1\.8 S/);
  assert.doesNotMatch(out, /QQQQQ/); // filler section excluded
  assert.match(out, /full doc on disk: content\/knowledge\/gear\.md/);
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

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which lens for tonight',
    userData,
  });
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

test('composeAutoRecall: injects only curated kinds — raw transcripts are excluded', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // No topic match → every injected entry is a Layer-2 snippet.
  writeYaml(
    userData,
    `topics:
  - id: unrelated
    match: [zzzznomatch]
    docs: [content/knowledge/none.md]
`,
  );
  // A raw conversation transcript (biographer INPUT, not curated memory) that even quotes a
  // stale fact — must never be injected, no matter how well it matches the query...
  ingest(db, null, {
    kind: 'session.captured',
    source: 's',
    content: 'lisbon photos trip — old transcript echo claiming the kit was $16,318.93',
  });
  // ...vs a curated belief about the same topic, which SHOULD surface.
  ingest(db, null, {
    kind: 'belief.update',
    source: 's',
    content: 'lisbon photos trip — curated belief fact',
    payload: { topic: 'lisbon-trip' },
  });

  const out = await composeAutoRecall({ db, llm: null, prompt: 'lisbon photos trip', userData });
  assert.ok(out, 'expected the curated belief to inject');
  assert.match(out, /curated belief fact/);
  assert.doesNotMatch(out, /transcript echo/); // raw transcript excluded by the allowlist
  assert.doesNotMatch(out, /16,318/); // and with it the superseded figure it replayed
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
  // Curated kind (knowledge.doc) so the snippets pass the allowlist; the cap, not the
  // allowlist, is what this test exercises.
  for (let i = 0; i < 6; i++) {
    ingest(db, null, {
      kind: 'knowledge.doc',
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

// ── Habit injection wire (design §9, Goal A) ─────────────────────────────────────

const TOPIC_YAML_NOMATCH = `topics:
  - id: unrelated
    match: [zzzznomatch]
    docs: [content/knowledge/none.md]
`;

/** Seed a few curated snippet rows so the factual block is non-empty + deterministic. */
function seedFactual(db: import('./db.ts').RobinDb) {
  for (let i = 0; i < 3; i++) {
    ingest(db, null, {
      kind: 'knowledge.doc',
      source: 's',
      content: `lisbon photos trip number ${i}`,
    });
  }
}

test('composeAutoRecall: with NO habits, an LLM dispatcher yields byte-identical factual output', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  seedFactual(db);

  // Baseline (the production path before this feature): lex-only, no dispatcher.
  const baseline = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.ok(baseline, 'baseline produced a factual block');

  // Same inputs, now WITH a dispatcher but ZERO habits in the store. The pre-embed gate
  // sees no habits → never pre-embeds → recall embeds internally → identical factual block.
  __resetAutoRecallCache();
  const withLlm = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.equal(withLlm, baseline, 'no-habit case is byte-identical to the pre-feature output');
  assert.doesNotMatch(withLlm ?? '', /Inferred tendencies/);
  closeDb(db);
});

test('composeAutoRecall: a relevant habit injects ≤2 hint lines in a SEPARATE block', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  seedFactual(db);

  // Three relevant habits (embedding == query vec → cosine 1.0); cap is 2.
  for (let i = 0; i < 3; i++) {
    insertHabit(db, {
      statement: `tends to do thing ${i}`,
      domain: 'creative',
      patternKind: 'temporal',
      embedding: FIXED_VEC,
    });
  }

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  // Separate, softer-labeled block present.
  assert.match(out, /🧭 Inferred tendencies/);
  const hintLines = out
    .split('\n')
    .filter((l) => l.includes('inferred tendency (hint, not fact):'));
  assert.equal(hintLines.length, 2, 'capped at top-2 hints');
  // The factual memory block is still there and unreduced.
  assert.match(out, /📓 From your memory/);
  const factualLines = out.split('\n').filter((l) => /^— \[/.test(l));
  assert.ok(factualLines.length >= 1, 'factual snippets still present');
  closeDb(db);
});

test('composeAutoRecall: habit slice does NOT reduce the factual slots', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  // 6 curated snippets → factual layer keeps its full SNIPPET_KEEP (4).
  for (let i = 0; i < 6; i++) {
    ingest(db, null, { kind: 'knowledge.doc', source: 's', content: `lisbon photos trip ${i}` });
  }
  insertHabit(db, {
    statement: 'a relevant tendency',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: FIXED_VEC,
  });

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.ok(out);
  const factualLines = out.split('\n').filter((l) => /^— \[/.test(l));
  assert.equal(factualLines.length, 4, 'factual block still keeps its full 4 slots');
  assert.match(out, /🧭 Inferred tendencies/);
  closeDb(db);
});

test('composeAutoRecall: a sensitive-domain habit is NOT injected at a normal relevance level', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  seedFactual(db);

  // Query embeds to FIXED_VEC; this habit sits at cosine ≈ 0.70 (above normal floor 0.60,
  // below the sensitive floor 0.78). A health (sensitive) habit must NOT inject.
  const mid = [0.7, Math.sqrt(1 - 0.49), 0, 0];
  insertHabit(db, {
    statement: 'a private health tendency',
    domain: 'health',
    patternKind: 'temporal',
    embedding: mid,
  });

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.ok(out, 'factual block still present');
  assert.doesNotMatch(out, /health tendency/, 'sensitive habit not injected at a normal match');
  assert.doesNotMatch(out, /Inferred tendencies/, 'no habit block at all');

  // The same sensitive habit at a STRONG match (cosine 1.0) DOES inject.
  __resetAutoRecallCache();
  const { userData: ud2, db: db2 } = makeEnv();
  writeYaml(ud2, TOPIC_YAML_NOMATCH);
  seedFactual(db2);
  insertHabit(db2, {
    statement: 'a private health tendency',
    domain: 'health',
    patternKind: 'temporal',
    embedding: FIXED_VEC,
  });
  const out2 = await composeAutoRecall({
    db: db2,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData: ud2,
  });
  assert.match(out2 ?? '', /health tendency/, 'sensitive habit injects on a strong topical match');
  closeDb(db);
  closeDb(db2);
});

test('composeAutoRecall: injectHabits:false injects no habit block', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  writePolicies(userData, 'behavior:\n  injectHabits: false\n');
  seedFactual(db);
  insertHabit(db, {
    statement: 'a relevant tendency',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: FIXED_VEC,
  });

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon photos trip',
    userData,
  });
  assert.ok(out, 'factual block still present');
  assert.doesNotMatch(out, /Inferred tendencies/, 'policy off → no habit block');
  closeDb(db);
});

test('composeAutoRecall: a habit-only injection (no factual hits) still surfaces the hint block', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // No topic match, no curated content → factual block empty.
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  insertHabit(db, {
    statement: 'tends to act on well-reasoned gear recs fast',
    domain: 'creative',
    patternKind: 'purchase',
    embedding: FIXED_VEC,
  });

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'unrelated to anything indexed',
    userData,
  });
  assert.ok(out, 'a habit-only injection is still returned');
  assert.doesNotMatch(
    out,
    /📓 From your memory/,
    'no factual header when there are no factual hits',
  );
  assert.match(out, /🧭 Inferred tendencies/);
  assert.match(out, /act on well-reasoned gear recs/);
  closeDb(db);
});

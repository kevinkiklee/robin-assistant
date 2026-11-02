import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import { insertHabit } from '../cognition/behavior/habits-store.ts';
import { insertRecommendation } from '../cognition/recommendations/store.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import {
  __resetAutoRecallCache,
  composeAutoRecall,
  isHarnessPrompt,
  isSensitiveDoc,
} from './auto-recall.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

// Fixtures name the operator "Sam"; pin the profile so the name-aware topic and
// claim filters see it instead of whatever user-data/config/operator.yaml holds.
setOperatorProfileForTests({
  name: 'Sam',
  context: null,
  aliases: [],
  privateTerms: [],
  home: null,
});

function makeEnv() {
  const userData = mkdtempSync(join(tmpdir(), 'robin-autorecall-'));
  mkdirSync(join(userData, 'config'), { recursive: true });
  mkdirSync(join(userData, 'content', 'knowledge'), { recursive: true });
  mkdirSync(join(userData, 'state', 'db'), { recursive: true });
  const db = openDb(join(userData, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  padCorpus(db);
  return { userData, db };
}

/**
 * Background corpus so bm25 behaves like it does on a real store. Auto-recall's lexical
 * floor (AUTO_RECALL_LEX_MIN_TERM_SCORE) is calibrated against a 40k-row corpus where a
 * topical term is rare; in a 3-row test DB every term is in every row, IDF collapses to
 * ~0 and nothing could pass. 400 un-evented filler rows (FTS-indexed via the insert
 * trigger, never recallable — no event points at them) restore realistic IDF.
 */
function padCorpus(db: ReturnType<typeof openDb>) {
  const ins = db.prepare('INSERT INTO events_content (ts, body) VALUES (?, ?)');
  const words = 'alpha bravo cedar delta echo foxtrot golf hotel india juliet kilo lima mike';
  db.transaction(() => {
    for (let i = 0; i < 400; i++) ins.run('2026-01-01T00:00:00.000Z', `${words} filler${i}`);
  })();
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

const KNIT_YAML = `topics:
  - id: knitting
    match: [yarn, skein, purl]
    docs: [content/knowledge/knitting.md]
`;

const KITCHEN_YAML = `topics:
  - id: kitchen
    match: [apron, mixer, baking]
    docs: [content/knowledge/kitchen.md]
`;

test('composeAutoRecall: injects the canonical doc when a topic matches', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1, Acme Tote');
  writeYaml(userData, KNIT_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which yarn should I use tonight',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  assert.match(out, /Acme Tote/);
  assert.match(out, /auto-recalled/);
  closeDb(db);
});

test('composeAutoRecall: returns null when no topic matches and recall is empty', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, KNIT_YAML);

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
  writeYaml(userData, KNIT_YAML);

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
  writeDoc(userData, 'content/knowledge/knitting.md', 'gear');
  writeYaml(userData, KNIT_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'yarn?', userData });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: gates out slash commands', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', 'gear');
  writeYaml(userData, KNIT_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: '/yarn settings explained',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: injects a whole doc at most once per session', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1');
  writeYaml(userData, KNIT_YAML);

  const sid = 'sess-dedup';
  const first = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which yarn tonight please',
    sessionId: sid,
    userData,
  });
  assert.ok(first && /Acme X1/.test(first));

  const second = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'and which yarn for daytime',
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
  // top-of-doc prefix — exactly the failure that hid a mid-doc line.
  const filler = 'Q'.repeat(6000);
  const doc = [
    '# Bakeware',
    '',
    '## Mixers',
    `Acme X1 mixer notes. ${filler}`,
    '',
    '## Aprons',
    'Acme Apron — quick-release apron with a padded waist tie.',
    '',
    '## Accessories',
    `Tea-towel ties. ${filler}`,
  ].join('\n');
  writeDoc(userData, 'content/knowledge/kitchen.md', doc);
  writeYaml(userData, KITCHEN_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'what is my quick-release apron and its waist tie',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  // The relevant section surfaced...
  assert.match(out, /Acme Apron/);
  assert.match(out, /quick-release/);
  // ...the off-topic filler did NOT crowd the block out of the inline budget...
  assert.doesNotMatch(out, /QQQQQ/);
  // ...the model is told it's a slice and where the full doc lives...
  assert.match(out, /full doc on disk: content\/knowledge\/kitchen\.md/);
  // ...and the whole block stays inline-sized.
  assert.ok(out.length < 6000, `expected a bounded block, got ${out.length}`);
  closeDb(db);
});

test('composeAutoRecall: an oversized doc can surface two relevant sections', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // A spanning question ("mitt cover AND pastry kit") should pull BOTH sections, not just the
  // single best — while the unrelated filler section stays out of the inline budget.
  const filler = 'Q'.repeat(6000);
  const doc = [
    '# Bakeware',
    '',
    '## Oven Mitts',
    'Acme Mitt Sleeve — silicone oven-mitt cover for wet dishes.',
    '',
    '## Filler',
    filler,
    '',
    '## Pastry Kits',
    'Acme Pastry Brush Kit — brush and scraper for floury counters.',
  ].join('\n');
  writeDoc(userData, 'content/knowledge/kitchen.md', doc);
  writeYaml(userData, KITCHEN_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which mitt cover and which pastry kit for baking days',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  assert.match(out, /Acme Mitt Sleeve/);
  assert.match(out, /Acme Pastry Brush Kit/);
  assert.doesNotMatch(out, /QQQQQ/); // filler section excluded
  assert.match(out, /full doc on disk: content\/knowledge\/kitchen\.md/);
  assert.ok(out.length < 6000, `expected a bounded block, got ${out.length}`);
  closeDb(db);
});

test('composeAutoRecall: hard-caps an oversized structureless doc and points to the file', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  // No H2 structure → nothing to slice to; the cap is the only thing keeping it inline.
  writeDoc(userData, 'content/knowledge/knitting.md', `HEAD ${'A'.repeat(15000)} TAIL`);
  writeYaml(userData, KNIT_YAML);

  const out = await composeAutoRecall({ db, llm: null, prompt: 'yarn advice please', userData });
  assert.ok(out);
  assert.match(out, /HEAD/); // top retained
  assert.doesNotMatch(out, /TAIL/); // tail dropped by the cap
  assert.match(out, /full doc on disk: content\/knowledge\/knitting\.md/);
  assert.ok(out.length < 6000, `expected a bounded block, got ${out.length}`);
  closeDb(db);
});

test('composeAutoRecall: injects a small canonical doc whole, never sliced', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  const doc = '# Knitting\n\n## Swatches\nAcme X1\n\n## Bags\nAcme Tote, Acme Lunch Bag';
  writeDoc(userData, 'content/knowledge/knitting.md', doc);
  writeYaml(userData, KNIT_YAML);

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which skein for tonight',
    userData,
  });
  assert.ok(out);
  // Under budget → both sections present, no slice marker.
  assert.match(out, /Acme X1/);
  assert.match(out, /Acme Tote/);
  assert.doesNotMatch(out, /full doc on disk/);
  closeDb(db);
});

test('composeAutoRecall: skips a topic whose doc file is missing', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(
    userData,
    `topics:
  - id: knitting
    match: [yarn]
    docs: [content/knowledge/missing.md]
`,
  );

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'yarn recommendation please',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('composeAutoRecall: reads the live doc content, not a cached copy', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', 'first version of the stash list');
  writeYaml(userData, KNIT_YAML);

  const a = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'yarn question number one',
    sessionId: 's-a',
    userData,
  });
  assert.ok(a && /first version/.test(a));

  // Edit the live file; a new session must see the new content.
  writeDoc(userData, 'content/knowledge/knitting.md', 'second version of the stash list');
  const b = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'yarn question number two',
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
    content: 'lisbon food trip — old transcript echo claiming the kit was $X,XXX.XX',
  });
  // ...vs a curated belief about the same topic, which SHOULD surface.
  ingest(db, null, {
    kind: 'belief.update',
    source: 's',
    content: 'lisbon food trip — curated belief fact',
    payload: { topic: 'lisbon-trip' },
  });

  const out = await composeAutoRecall({ db, llm: null, prompt: 'lisbon food trip', userData });
  assert.ok(out, 'expected the curated belief to inject');
  assert.match(out, /curated belief fact/);
  assert.doesNotMatch(out, /transcript echo/); // raw transcript excluded by the allowlist
  assert.doesNotMatch(out, /X,XXX/); // and with it the superseded figure it replayed
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
      content: `lisbon food trip number ${i}`,
    });
  }

  // lex FTS requires all query tokens present in a row; keep the prompt to shared tokens.
  const out = await composeAutoRecall({ db, llm: null, prompt: 'lisbon food trip', userData });
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
      content: `lisbon food trip number ${i}`,
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
    prompt: 'lisbon food trip',
    userData,
  });
  assert.ok(baseline, 'baseline produced a factual block');

  // Same inputs, now WITH a dispatcher but ZERO habits in the store. The pre-embed gate
  // sees no habits → never pre-embeds → recall embeds internally → identical factual block.
  __resetAutoRecallCache();
  const withLlm = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'lisbon food trip',
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
    prompt: 'lisbon food trip',
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
    ingest(db, null, { kind: 'knowledge.doc', source: 's', content: `lisbon food trip ${i}` });
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
    prompt: 'lisbon food trip',
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
    prompt: 'lisbon food trip',
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
    prompt: 'lisbon food trip',
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
    prompt: 'lisbon food trip',
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

// ── Open-loops slice (design 2026-08-10 §5) ──────────────────────────────────────

test('composeAutoRecall: injects open loops when the prompt names an open rec subject', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  insertRecommendation(db, {
    subject: 'Acme Label Maker',
    claim: 'buy the wide-tape model',
    verdict: 'buy',
    domain: 'creative',
  });

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'thinking about the Acme Label Maker again',
    userData,
  });
  assert.match(out ?? '', /Open loops on this topic/);
  assert.match(out ?? '', /#\d+ \[buy\] Acme Label Maker/);
  assert.match(out ?? '', /buy the wide-tape model/);
  closeDb(db);
});

test('composeAutoRecall: no subject match → no open-loops block', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  insertRecommendation(db, {
    subject: 'Acme Label Maker',
    claim: 'x',
    verdict: 'buy',
    domain: 'creative',
  });

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'what should I cook for dinner tonight',
    userData,
  });
  assert.doesNotMatch(out ?? '', /Open loops/);
  closeDb(db);
});

test('composeAutoRecall: open-loops slice is session-deduped and capped at 3', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  // 5 open recs, all matching the prompt. Cap is 3 per turn; the session `seen` set
  // dedupes across turns, so a second call in the SAME session injects the other 2.
  for (let i = 0; i < 5; i++) {
    insertRecommendation(db, {
      subject: 'Acme Label Maker',
      claim: `claim number ${i}`,
      verdict: 'buy',
      domain: 'creative',
    });
  }

  const sid = 'sess-loops';
  const first = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'thinking about the Acme Label Maker again',
    sessionId: sid,
    userData,
  });
  assert.ok(first, 'expected a first-turn injection');
  const firstLoops = first.split('\n').filter((l) => /^— #\d+ \[buy\]/.test(l));
  assert.equal(firstLoops.length, 3, 'first call capped at 3 open loops');

  const second = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'still weighing the Acme Label Maker for the office',
    sessionId: sid,
    userData,
  });
  assert.ok(second, 'expected a second-turn injection');
  const secondLoops = second.split('\n').filter((l) => /^— #\d+ \[buy\]/.test(l));
  assert.equal(secondLoops.length, 2, 'second call injects only the 2 not yet seen');
  // No overlap between turns: every rec id injected at most once per session.
  const ids = [...firstLoops, ...secondLoops].map((l) => l.match(/^— #(\d+)/)?.[1]);
  assert.equal(new Set(ids).size, 5, 'all 5 recs injected exactly once across the session');
  closeDb(db);
});

test('composeAutoRecall: injectOpenLoops:false injects no open-loops block', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  writePolicies(userData, 'recommendations:\n  injectOpenLoops: false\n');
  insertRecommendation(db, {
    subject: 'Acme Label Maker',
    claim: 'buy the wide-tape model',
    verdict: 'buy',
    domain: 'creative',
  });

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'thinking about the Acme Label Maker again',
    userData,
  });
  assert.doesNotMatch(out ?? '', /Open loops/);
  closeDb(db);
});

// ── Kept-set recording (recall_log.kept_json, value-loops plan 2 T4) ─────────────

test('composeAutoRecall: records its true kept set (docs + surviving snippets) in kept_json', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1, Acme Tote');
  writeYaml(userData, KNIT_YAML);
  // A curated belief carrying every prompt token, so one snippet survives the allowlist...
  ingest(db, null, {
    kind: 'belief.update',
    source: 's',
    content: 'yarn lisbon food trip — curated belief fact',
    payload: { topic: 'lisbon-trip' },
  });
  // ...and a raw transcript recall() RETURNS but composition DROPS — it must not appear
  // in the kept set. That gap (returned vs actually injected) is what kept_json records.
  ingest(db, null, {
    kind: 'session.captured',
    source: 's',
    content: 'yarn lisbon food trip — transcript echo',
  });

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'yarn lisbon food trip',
    userData,
  });
  assert.ok(out, 'expected an injection block');
  assert.match(out, /Acme Tote/); // Layer-1 doc injected
  assert.match(out, /curated belief fact/); // Layer-2 snippet injected

  const row = db
    .prepare(`SELECT kept_json FROM recall_log WHERE source = 'auto' ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string | null };
  assert.ok(row?.kept_json, 'kept_json written on the auto-tagged recall_log row');
  const kept = JSON.parse(row.kept_json);
  assert.deepEqual(kept.docs, ['content/knowledge/knitting.md'], 'Layer-1 doc paths recorded');
  const beliefContentId = (
    db.prepare(`SELECT id FROM events_content WHERE body LIKE '%curated belief fact%'`).get() as {
      id: number;
    }
  ).id;
  assert.deepEqual(kept.snippets, [beliefContentId], 'only the allowlist survivor is kept');
  assert.equal(kept.habits, 0);
  assert.equal(kept.loops, 0);
  closeDb(db);
});

test('composeAutoRecall: kept_json counts the habit and open-loop lines', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  insertHabit(db, {
    statement: 'tends to act on well-reasoned gear recs fast',
    domain: 'creative',
    patternKind: 'purchase',
    embedding: FIXED_VEC,
  });
  insertRecommendation(db, {
    subject: 'Acme Label Maker',
    claim: 'buy the wide-tape model',
    verdict: 'buy',
    domain: 'creative',
  });

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'thinking about the Acme Label Maker again',
    userData,
  });
  assert.ok(out, 'expected a habit + loop injection');

  const row = db
    .prepare(`SELECT kept_json FROM recall_log WHERE source = 'auto' ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string | null };
  assert.ok(row?.kept_json, 'kept_json written even when only bonus slices inject');
  const kept = JSON.parse(row.kept_json);
  assert.deepEqual(kept.docs, []);
  assert.deepEqual(kept.snippets, []);
  assert.equal(kept.habits, 1);
  assert.equal(kept.loops, 1);
  closeDb(db);
});

test('composeAutoRecall: no recall_log row id → no kept_json write, composition stands', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1');
  writeYaml(userData, KNIT_YAML);
  // Simulate the no-row-id path: with recall_log gone, logRecall's INSERT fails (it
  // swallows), onLogged never fires, and there is no row to UPDATE. Layer-1 must still
  // inject and composeAutoRecall must not throw — degrade silently.
  db.exec('DROP TABLE recall_log');

  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which yarn should I use tonight',
    userData,
  });
  assert.ok(out && /Acme X1/.test(out), 'Layer-1 doc still injects without a log row');
  closeDb(db);
});

test('composeAutoRecall: a kept_json write failure cannot break composition', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1');
  writeYaml(userData, KNIT_YAML);

  // A db whose kept_json UPDATE throws while every other statement works: the kept-set
  // write is instrumentation and must never take the injection down with it.
  const failing = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('kept_json')) throw new Error('injected kept_json write failure');
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof db;

  const out = await composeAutoRecall({
    db: failing,
    llm: null,
    prompt: 'which yarn should I use tonight',
    userData,
  });
  assert.ok(out && /Acme X1/.test(out), 'composition survives the failed kept-set write');

  const row = db
    .prepare(`SELECT kept_json FROM recall_log WHERE source = 'auto' ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string | null };
  assert.equal(row.kept_json, null, 'the row exists but kept_json stayed unwritten');
  closeDb(db);
});

// ── Harness prompts, sensitive docs, corrections, honest outcome (2026-10-03) ─────

test('isHarnessPrompt: harness/automation text is recognized, user turns are not', () => {
  for (const p of [
    '<task-notification>\n<task-id>b7f3</task-id> whoop poll completed',
    '  <system-reminder>stuff</system-reminder>',
    '<local-command-stdout>ok</local-command-stdout>',
    '<command-name>/clear</command-name>',
    '[SYSTEM NOTIFICATION] background job finished',
    'Another Claude session sent a message:\n<cross-session-message from="x">',
    'Stop hook feedback:\nYou MUST call the StructuredOutput tool',
    'Caveat: The messages below were generated by the user while running local commands.',
  ]) {
    assert.equal(isHarnessPrompt(p), true, p);
  }
  assert.equal(isHarnessPrompt('how is my whoop recovery this week'), false);
  assert.equal(isHarnessPrompt('why did <task-notification> fire twice?'), false);
});

test('composeAutoRecall: a <task-notification> never triggers recall, even on a topic keyword', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme X1');
  writeYaml(userData, KNIT_YAML);
  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: '<task-notification>yarn skein purl export finished</task-notification>',
    userData,
  });
  assert.equal(out, null);
  const n = db.prepare('SELECT COUNT(*) AS n FROM recall_log').get() as { n: number };
  assert.equal(n.n, 0, 'no recall ran');
  closeDb(db);
});

test('composeAutoRecall: an all-stopword prompt recalls nothing', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  seedFactual(db);
  const out = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'ok sounds good, do that',
    userData,
  });
  assert.equal(out, null);
  closeDb(db);
});

test('isSensitiveDoc: reads top-level or nested frontmatter flags only', () => {
  assert.equal(isSensitiveDoc('---\ntitle: x\nsensitive: true\n---\nbody'), true);
  assert.equal(isSensitiveDoc('---\nmetadata:\n  sensitive: true\n  pii: true\n---\n'), true);
  assert.equal(isSensitiveDoc('---\nsensitive: false\n---\n'), false);
  assert.equal(isSensitiveDoc('# Doc\nsensitive: true in prose'), false);
});

const SENSITIVE_YAML = `topics:
  - id: bakery
    match: [sourdough, starter, levain, crumb]
    docs: [content/knowledge/bakery.md]
  - id: knitting
    match: [yarn, needle, stitch]
    docs: [content/knowledge/knitting.md]
`;

test('composeAutoRecall: a sensitive Layer-1 doc needs ≥2 distinct topic terms', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeDoc(
    userData,
    'content/knowledge/bakery.md',
    '---\nname: bakery-notes\nmetadata:\n  sensitive: true\n---\n# Bakery\nHydration 78',
  );
  writeDoc(userData, 'content/knowledge/knitting.md', '# Knitting\nAcme Merino');
  writeYaml(userData, SENSITIVE_YAML);

  const oneTerm = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'the sourdough sync job keeps timing out',
    userData,
  });
  assert.doesNotMatch(oneTerm ?? '', /Hydration 78/, 'one stray keyword must not pull the notes');

  const onTopic = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'how is my sourdough starter and levain doing',
    userData,
  });
  assert.match(onTopic ?? '', /Hydration 78/);

  // A non-sensitive doc still injects on a single term.
  const gear = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'which yarn for tonight',
    userData,
  });
  assert.match(gear ?? '', /Acme Merino/);
  closeDb(db);
});

test('composeAutoRecall: a sensitive knowledge.doc snippet never injects on lexical evidence alone', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: '---\nsensitive: true\n---\n# Dental history lisbon food trip notes',
  });
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: '# Lisbon tiles trip plan',
  });
  const out = await composeAutoRecall({ db, llm: null, prompt: 'lisbon food trip', userData });
  assert.match(out ?? '', /Lisbon tiles trip plan/);
  assert.doesNotMatch(out ?? '', /Dental/);
  closeDb(db);
});

function addCorrectionWithVec(
  db: import('./db.ts').RobinDb,
  correction: string,
  vec: number[],
): number {
  const id = Number(
    db
      .prepare('INSERT INTO corrections (what, correction) VALUES (?, ?)')
      .run('Robin got it wrong', correction).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO correction_embeddings (correction_id, text_sha, embedding, embedded_at)
     VALUES (?, 'sha', ?, ?)`,
  ).run(id, Buffer.from(Float32Array.from(vec).buffer), new Date().toISOString());
  return id;
}

test('composeAutoRecall: injects the relevant correction (not unrelated ones), once per session', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  const early = addCorrectionWithVec(
    db,
    'Sam does NOT want early flights — midday only.',
    FIXED_VEC,
  );
  addCorrectionWithVec(db, 'The X1 is the backup mixer.', [0, 1, 0, 0]);

  const out = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'find me a flight to lakeport',
    sessionId: 's-corr',
    userData,
  });
  assert.ok(out);
  assert.match(out, /Corrections Sam made/);
  assert.match(out, new RegExp(`#${early} Sam does NOT want early flights`));
  assert.doesNotMatch(out, /backup mixer/);

  const row = db
    .prepare(`SELECT kept_json, outcome FROM recall_log ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string; outcome: string };
  assert.deepEqual(JSON.parse(row.kept_json).corrections, [early]);
  assert.equal(row.outcome, 'injected');

  const again = await composeAutoRecall({
    db,
    llm: mockLLM(),
    prompt: 'find me a flight to lakeport again',
    sessionId: 's-corr',
    userData,
  });
  assert.doesNotMatch(again ?? '', /want early flights/, 'session-deduped');
  closeDb(db);
});

test('composeAutoRecall: an empty turn still records kept_json and a derived outcome', async () => {
  __resetAutoRecallCache();
  const { userData, db } = makeEnv();
  writeYaml(userData, TOPIC_YAML_NOMATCH);
  // Pool non-empty but nothing survives: the only lex hit is a sensitive doc.
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: '---\nsensitive: true\n---\nlisbon food trip medical',
  });
  const filtered = await composeAutoRecall({
    db,
    llm: null,
    prompt: 'lisbon food trip',
    userData,
  });
  assert.equal(filtered, null);
  const f = db
    .prepare(`SELECT kept_json, outcome FROM recall_log ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string; outcome: string };
  assert.equal(f.outcome, 'filtered');
  assert.deepEqual(JSON.parse(f.kept_json), {
    docs: [],
    snippets: [],
    corrections: [],
    habits: 0,
    loops: 0,
  });

  const miss = await composeAutoRecall({ db, llm: null, prompt: 'zanzibar quokka', userData });
  assert.equal(miss, null);
  const m = db
    .prepare(`SELECT kept_json, outcome FROM recall_log ORDER BY id DESC LIMIT 1`)
    .get() as { kept_json: string; outcome: string };
  assert.equal(m.outcome, 'miss');
  assert.ok(m.kept_json);
  closeDb(db);
});

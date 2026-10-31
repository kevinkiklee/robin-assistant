import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  countTopicTermHits,
  loadRecallTopics,
  matchTopics,
  validateRecallTopics,
} from './recall-topics.ts';

test('countTopicTermHits: distinct whole-word terms; a term inside a longer match counts once', () => {
  const rule = {
    id: 'knitting',
    match: ['yarn', 'gauge', 'cable', 'cable stitch', 'twisted cable stitch', 'Purl'],
    docs: ['x.md'],
  };
  assert.equal(countTopicTermHits('yarn order arrived late', rule), 1);
  assert.equal(countTopicTermHits('my yarn gauge and purl rows', rule), 3);
  assert.equal(countTopicTermHits('how do I work a twisted cable stitch', rule), 1);
  assert.equal(countTopicTermHits('gauged loosely', rule), 0);
});

/** Build a temp userData dir with a config/ and content/ tree. */
function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-topics-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'content', 'knowledge'), { recursive: true });
  return dir;
}

function writeYaml(userData: string, body: string): void {
  writeFileSync(join(userData, 'config', 'recall-topics.yaml'), body);
}

test('loadRecallTopics: parses a valid topic map', () => {
  const ud = makeUserData();
  writeYaml(
    ud,
    `topics:
  - id: board-games
    match: [meeple, dice, rulebook]
    docs: [content/knowledge/board-games.md]
  - id: knitting
    match: [yarn, needle]
    docs: [content/knowledge/knitting.md]
`,
  );
  const rules = loadRecallTopics(ud);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].id, 'board-games');
  assert.deepEqual(rules[0].match, ['meeple', 'dice', 'rulebook']);
  assert.deepEqual(rules[1].docs, ['content/knowledge/knitting.md']);
});

test('loadRecallTopics: missing file returns []', () => {
  const ud = makeUserData(); // no yaml written
  assert.deepEqual(loadRecallTopics(ud), []);
});

test('loadRecallTopics: malformed yaml returns [] (never throws)', () => {
  const ud = makeUserData();
  writeYaml(ud, 'topics: [this is : not : valid yaml ::::\n  - broken');
  assert.deepEqual(loadRecallTopics(ud), []);
});

test('loadRecallTopics: non-array topics returns []', () => {
  const ud = makeUserData();
  writeYaml(ud, 'topics: not-a-list\n');
  assert.deepEqual(loadRecallTopics(ud), []);
});

test('matchTopics: case-insensitive word-boundary match of any term', () => {
  const rules = [
    { id: 'board-games', match: ['meeple', 'dice', 'rulebook'], docs: ['a.md'] },
    { id: 'knitting', match: ['yarn', 'needle'], docs: ['b.md'] },
  ];
  const hits = matchTopics('Which RULEBOOK covers the expansion?', rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'board-games');
});

test('matchTopics: no match returns []', () => {
  const rules = [{ id: 'board-games', match: ['meeple', 'dice'], docs: ['a.md'] }];
  assert.deepEqual(matchTopics('how do I deploy this service', rules), []);
});

test('matchTopics: word-boundary avoids substring false positives', () => {
  const rules = [{ id: 'art', match: ['art'], docs: ['a.md'] }];
  // "started" contains "art" as a substring but not as a word — must NOT match.
  assert.deepEqual(matchTopics('I started the build', rules), []);
  assert.equal(matchTopics('I love art', rules).length, 1);
});

test('matchTopics: preserves rule (map) order, dedups multi-term hits', () => {
  const rules = [
    { id: 'a', match: ['alpha'], docs: ['a.md'] },
    { id: 'b', match: ['beta', 'gamma'], docs: ['b.md'] },
  ];
  // Both beta and gamma present — rule b returned once; order a-before-b.
  const hits = matchTopics('alpha beta gamma', rules);
  assert.deepEqual(
    hits.map((r) => r.id),
    ['a', 'b'],
  );
});

test('validateRecallTopics: reports missing doc paths', () => {
  const ud = makeUserData();
  writeFileSync(join(ud, 'content', 'knowledge', 'present.md'), '# present');
  writeYaml(
    ud,
    `topics:
  - id: ok
    match: [foo]
    docs: [content/knowledge/present.md]
  - id: broken
    match: [bar]
    docs: [content/knowledge/missing.md]
`,
  );
  const result = validateRecallTopics(ud);
  assert.equal(result.topicCount, 2);
  assert.deepEqual(result.missingDocs, ['content/knowledge/missing.md']);
  assert.deepEqual(result.oversizedDocs, []);
});

test('validateRecallTopics: all-present, in-budget yields no missing/oversized', () => {
  const ud = makeUserData();
  writeFileSync(join(ud, 'content', 'knowledge', 'a.md'), 'a');
  writeYaml(
    ud,
    `topics:
  - id: ok
    match: [foo]
    docs: [content/knowledge/a.md]
`,
  );
  const result = validateRecallTopics(ud);
  assert.equal(result.topicCount, 1);
  assert.deepEqual(result.missingDocs, []);
  assert.deepEqual(result.oversizedDocs, []);
});

test('validateRecallTopics: flags an oversized doc that is un-sliceable (no H2)', () => {
  const ud = makeUserData();
  writeFileSync(join(ud, 'content', 'knowledge', 'big.md'), 'B'.repeat(17000));
  writeYaml(
    ud,
    `topics:
  - id: huge
    match: [foo]
    docs: [content/knowledge/big.md]
`,
  );
  const result = validateRecallTopics(ud);
  assert.deepEqual(result.missingDocs, []);
  assert.equal(result.oversizedDocs.length, 1);
  assert.equal(result.oversizedDocs[0].doc, 'content/knowledge/big.md');
  assert.ok(result.oversizedDocs[0].chars >= 17000);
});

test('validateRecallTopics: does NOT flag an oversized doc that has ## sections (sliceable)', () => {
  const ud = makeUserData();
  const big = `# Ref\n\n## Section One\n${'B'.repeat(17000)}\n\n## Section Two\nmore`;
  writeFileSync(join(ud, 'content', 'knowledge', 'sectioned.md'), big);
  writeYaml(
    ud,
    `topics:
  - id: huge
    match: [foo]
    docs: [content/knowledge/sectioned.md]
`,
  );
  const result = validateRecallTopics(ud);
  assert.deepEqual(result.missingDocs, []);
  assert.deepEqual(result.oversizedDocs, []); // sectioned → sliceable → not flagged
});

test('matchTopics: model-number terms do not cross-fire (word-boundary)', () => {
  const rules = [
    { id: 'needle-us8', match: ['us8'], docs: ['us8.md'] },
    { id: 'needle-us8circular', match: ['us8circular'], docs: ['us8circular.md'] },
  ];
  // "us8circular" must hit ONLY the us8circular rule — \bus8\b does not match inside "us8circular".
  assert.deepEqual(
    matchTopics('how do I cast on with my us8circular', rules).map((r) => r.id),
    ['needle-us8circular'],
  );
  // bare "us8" hits ONLY us8.
  assert.deepEqual(
    matchTopics('binding off a scarf on the us8', rules).map((r) => r.id),
    ['needle-us8'],
  );
});

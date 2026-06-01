import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRecallTopics, matchTopics, validateRecallTopics } from './recall-topics.ts';

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
  - id: photography
    match: [photo, camera, lens]
    docs: [content/knowledge/gear.md]
  - id: movies
    match: [movie, film]
    docs: [content/knowledge/movies.md]
`,
  );
  const rules = loadRecallTopics(ud);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].id, 'photography');
  assert.deepEqual(rules[0].match, ['photo', 'camera', 'lens']);
  assert.deepEqual(rules[1].docs, ['content/knowledge/movies.md']);
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
    { id: 'photography', match: ['photo', 'camera', 'lens'], docs: ['a.md'] },
    { id: 'movies', match: ['movie', 'film'], docs: ['b.md'] },
  ];
  const hits = matchTopics('What CAMERA should I use tonight?', rules);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'photography');
});

test('matchTopics: no match returns []', () => {
  const rules = [{ id: 'photography', match: ['photo', 'camera'], docs: ['a.md'] }];
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

test('validateRecallTopics: flags an oversized doc (injected whole every turn)', () => {
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

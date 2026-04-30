import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugify,
  watchPath,
  watchStatePath,
  listWatches,
  readWatchState,
  writeWatchState,
  parseWatchFile,
  serializeWatchFile,
} from '../scripts/lib/watches.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-watches-lib-'));
  return dir;
}

function makeWatch(ws, id, frontmatter = {}, body = '') {
  const dir = join(ws, 'user-data/memory/watches');
  mkdirSync(dir, { recursive: true });
  const fm = {
    id,
    topic: `Topic for ${id}`,
    query: `query for ${id}`,
    sources: [],
    cadence: 'daily',
    last_run_at: null,
    notify: false,
    enabled: true,
    created_at: '2026-04-30',
    ...frontmatter,
  };
  const content = serializeWatchFile(fm, body || `# Watch: ${id}\n`);
  writeFileSync(join(dir, `${id}.md`), content);
  return content;
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

test('slugify: basic kebab-case', () => {
  assert.equal(slugify('new Sigma lens releases'), 'new-sigma-lens-releases');
});

test("slugify: strips punctuation and apostrophes", () => {
  // apostrophe removed; the trailing 's stays (possessive -> genitive slug)
  assert.equal(slugify("Aronofsky's mother! Blu-ray release"), 'aronofskys-mother-blu-ray-release');
});

test('slugify: collapses multiple spaces/hyphens', () => {
  assert.equal(slugify('foo   ---   bar'), 'foo-bar');
});

test('slugify: max 60 chars', () => {
  const long = 'a'.repeat(100);
  assert.equal(slugify(long).length, 60);
});

test('slugify: trims leading/trailing hyphens', () => {
  assert.equal(slugify('  hello world  '), 'hello-world');
});

test('slugify: already clean slug passes through', () => {
  assert.equal(slugify('sigma-35mm'), 'sigma-35mm');
});

test('slugify: numbers preserved', () => {
  assert.equal(slugify('iPhone 16 Pro Max release'), 'iphone-16-pro-max-release');
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

test('watchPath: returns correct path', () => {
  const ws = '/tmp/test-ws';
  assert.equal(watchPath(ws, 'my-watch'), '/tmp/test-ws/user-data/memory/watches/my-watch.md');
});

test('watchStatePath: returns correct path', () => {
  const ws = '/tmp/test-ws';
  assert.equal(watchStatePath(ws, 'my-watch'), '/tmp/test-ws/user-data/state/watches/my-watch.json');
});

// ---------------------------------------------------------------------------
// parseWatchFile / serializeWatchFile
// ---------------------------------------------------------------------------

test('parseWatchFile: parses frontmatter and body', () => {
  const content = `---
id: test-watch
topic: "Test topic"
cadence: daily
last_run_at: null
notify: false
enabled: true
sources: []
---

# Watch: test-watch

Some notes.
`;
  const { frontmatter, body } = parseWatchFile(content);
  assert.equal(frontmatter.id, 'test-watch');
  assert.equal(frontmatter.topic, 'Test topic');
  assert.equal(frontmatter.cadence, 'daily');
  assert.equal(frontmatter.last_run_at, null);
  assert.equal(frontmatter.notify, false);
  assert.equal(frontmatter.enabled, true);
  assert.deepEqual(frontmatter.sources, []);
  assert.match(body, /# Watch: test-watch/);
});

test('parseWatchFile: handles missing frontmatter gracefully', () => {
  const content = '# Just a body\nNo frontmatter here.';
  const { frontmatter, body } = parseWatchFile(content);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, content);
});

test('serializeWatchFile: roundtrip is stable', () => {
  const fm = {
    id: 'roundtrip-test',
    topic: 'Roundtrip test',
    cadence: 'weekly',
    last_run_at: null,
    notify: false,
    enabled: true,
    sources: [],
    created_at: '2026-04-30',
  };
  const body = '# Watch: roundtrip-test\n\nSome notes.\n';
  const serialized = serializeWatchFile(fm, body);
  const { frontmatter: fm2, body: body2 } = parseWatchFile(serialized);
  assert.equal(fm2.id, fm.id);
  assert.equal(fm2.topic, fm.topic);
  assert.equal(fm2.cadence, fm.cadence);
  assert.equal(fm2.last_run_at, fm.last_run_at);
  assert.equal(fm2.notify, fm.notify);
  assert.equal(fm2.enabled, fm.enabled);
  assert.match(body2, /# Watch: roundtrip-test/);
});

// ---------------------------------------------------------------------------
// listWatches
// ---------------------------------------------------------------------------

test('listWatches: returns empty array when directory missing', () => {
  const ws = workspace();
  const watches = listWatches(ws);
  assert.deepEqual(watches, []);
});

test('listWatches: returns empty array for empty directory', () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/memory/watches'), { recursive: true });
  const watches = listWatches(ws);
  assert.deepEqual(watches, []);
});

test('listWatches: skips INDEX.md and log.md', () => {
  const ws = workspace();
  const dir = join(ws, 'user-data/memory/watches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'INDEX.md'), '# INDEX\n');
  writeFileSync(join(dir, 'log.md'), '# Log\n');
  const watches = listWatches(ws);
  assert.equal(watches.length, 0);
});

test('listWatches: lists watch files correctly', () => {
  const ws = workspace();
  makeWatch(ws, 'sigma-lens', { topic: 'Sigma lens releases', cadence: 'daily' });
  makeWatch(ws, 'aronofsky-bluray', { topic: "Aronofsky Blu-ray", cadence: 'weekly' });
  const watches = listWatches(ws);
  assert.equal(watches.length, 2);
  const ids = watches.map((w) => w.id).sort();
  assert.deepEqual(ids, ['aronofsky-bluray', 'sigma-lens']);
});

test('listWatches: watch enabled defaults to true when not set', () => {
  const ws = workspace();
  const dir = join(ws, 'user-data/memory/watches');
  mkdirSync(dir, { recursive: true });
  // Write without enabled field
  writeFileSync(join(dir, 'no-enabled.md'), '---\nid: no-enabled\ntopic: Test\n---\n# Watch\n');
  const watches = listWatches(ws);
  assert.equal(watches[0].enabled, true);
});

test('listWatches: disabled watch shows enabled=false', () => {
  const ws = workspace();
  makeWatch(ws, 'disabled-watch', { enabled: false });
  const watches = listWatches(ws);
  assert.equal(watches[0].enabled, false);
});

// ---------------------------------------------------------------------------
// readWatchState / writeWatchState
// ---------------------------------------------------------------------------

test('readWatchState: returns default when file missing', () => {
  const ws = workspace();
  const state = readWatchState(ws, 'nonexistent');
  assert.equal(state.id, 'nonexistent');
  assert.deepEqual(state.fingerprints, []);
  assert.equal(state.last_run_at, null);
  assert.equal(state.consecutive_failures, 0);
});

test('writeWatchState + readWatchState: round-trip', () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state/watches'), { recursive: true });
  const state = {
    id: 'round-trip',
    fingerprints: ['sha256:abc123', 'sha256:def456'],
    last_run_at: '2026-04-30T14:00:00Z',
    consecutive_failures: 0,
  };
  writeWatchState(ws, 'round-trip', state);
  const read = readWatchState(ws, 'round-trip');
  assert.equal(read.id, 'round-trip');
  assert.deepEqual(read.fingerprints, state.fingerprints);
  assert.equal(read.last_run_at, state.last_run_at);
  assert.equal(read.consecutive_failures, 0);
});

test('writeWatchState: atomic write — no .tmp file left behind', () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state/watches'), { recursive: true });
  writeWatchState(ws, 'atomic-test', { fingerprints: [], last_run_at: null, consecutive_failures: 0 });
  const tmpPath = join(ws, 'user-data/state/watches', 'atomic-test.json.tmp');
  assert.ok(!existsSync(tmpPath), '.tmp file should not exist after write');
});

test('writeWatchState: creates state directory if missing', () => {
  const ws = workspace();
  // Do NOT pre-create the state/watches dir
  writeWatchState(ws, 'no-dir-test', { fingerprints: [], last_run_at: null, consecutive_failures: 0 });
  const statePath = join(ws, 'user-data/state/watches/no-dir-test.json');
  assert.ok(existsSync(statePath), 'state file should be created');
});

test('readWatchState: handles corrupt JSON gracefully', () => {
  const ws = workspace();
  const dir = join(ws, 'user-data/state/watches');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'corrupt.json'), 'not valid json {{{');
  const state = readWatchState(ws, 'corrupt');
  assert.equal(state.id, 'corrupt');
  assert.deepEqual(state.fingerprints, []);
});

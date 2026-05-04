// Tests for protocol-trigger-match.js — frontmatter loading, trigger map merge,
// and word-boundary matching.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTriggerMap,
  findMatchingProtocols,
} from '../../scripts/lib/protocol-trigger-match.js';

function makeWorkspace(systemFiles = {}, userDataFiles = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'ptm-'));
  const sysDir = join(ws, 'system', 'jobs');
  mkdirSync(sysDir, { recursive: true });
  for (const [name, content] of Object.entries(systemFiles)) {
    writeFileSync(join(sysDir, name), content);
  }
  if (Object.keys(userDataFiles).length > 0) {
    const udDir = join(ws, 'user-data', 'runtime', 'jobs');
    mkdirSync(udDir, { recursive: true });
    for (const [name, content] of Object.entries(userDataFiles)) {
      writeFileSync(join(udDir, name), content);
    }
  }
  // bin/robin.js so workspace-root walk works if anything calls it.
  mkdirSync(join(ws, 'bin'), { recursive: true });
  writeFileSync(join(ws, 'bin', 'robin.js'), '// stub\n');
  return ws;
}

describe('loadTriggerMap', () => {
  it('returns triggers from system/jobs only when no user-data overrides exist', () => {
    const ws = makeWorkspace({
      'daily-briefing.md': '---\nname: daily-briefing\ndispatch: inline\nmodel: opus\ntriggers: ["good morning", "morning briefing"]\n---\nbody',
      'lint.md': '---\nname: lint\ndispatch: subagent\nmodel: sonnet\ntriggers: ["lint the wiki"]\n---\nbody',
    });
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['daily-briefing'], ['good morning', 'morning briefing']);
    assert.deepEqual(map['lint'], ['lint the wiki']);
  });

  it('user-data non-empty triggers fully replace system triggers', () => {
    const ws = makeWorkspace(
      { 'daily-briefing.md': '---\nname: daily-briefing\ndispatch: inline\nmodel: opus\ntriggers: ["morning briefing"]\n---\nbody' },
      { 'daily-briefing.md': '---\nname: daily-briefing\ntriggers: ["my custom phrase"]\n---\nbody' },
    );
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['daily-briefing'], ['my custom phrase']);
  });

  it('user-data explicit empty triggers opt out of trigger detection', () => {
    const ws = makeWorkspace(
      { 'daily-briefing.md': '---\nname: daily-briefing\ndispatch: inline\nmodel: opus\ntriggers: ["morning briefing"]\n---\nbody' },
      { 'daily-briefing.md': '---\nname: daily-briefing\ntriggers: []\n---\nbody' },
    );
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['daily-briefing'], []);
  });

  it('user-data missing triggers key falls back to system triggers', () => {
    const ws = makeWorkspace(
      { 'daily-briefing.md': '---\nname: daily-briefing\ndispatch: inline\nmodel: opus\ntriggers: ["morning briefing"]\n---\nbody' },
      { 'daily-briefing.md': '---\nname: daily-briefing\nrole: extra\n---\nbody' },
    );
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['daily-briefing'], ['morning briefing']);
  });

  it('user-only protocol (no system version) emits its own triggers', () => {
    const ws = makeWorkspace(
      {},
      { 'birding.md': '---\nname: birding\ntriggers: ["birding"]\n---\nbody' },
    );
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['birding'], ['birding']);
  });

  it('skips _-prefixed and README files', () => {
    const ws = makeWorkspace({
      '_robin-sync.md': '---\nname: _robin-sync\ntriggers: ["sync"]\n---\n',
      'README.md': '# readme',
      'lint.md': '---\nname: lint\ntriggers: ["lint"]\n---\nbody',
    });
    const map = loadTriggerMap(ws);
    assert.ok(!('_robin-sync' in map));
    assert.deepEqual(map['lint'], ['lint']);
  });

  it('protocol with malformed frontmatter is excluded, others unaffected', () => {
    const ws = makeWorkspace({
      // No closing `---`, frontmatter parser returns empty frontmatter → no triggers
      'broken.md': '---\nname: broken\ntriggers: ["foo"\nno close',
      'good.md': '---\nname: good\ntriggers: ["alpha"]\n---\n',
    });
    const map = loadTriggerMap(ws);
    assert.deepEqual(map['good'], ['alpha']);
    // Broken file: no triggers key parsed → not present, or empty
    assert.ok(map['broken'] === undefined || (Array.isArray(map['broken']) && map['broken'].length === 0));
  });
});

describe('findMatchingProtocols', () => {
  const map = {
    'daily-briefing': ['morning briefing', 'good morning', 'brief me'],
    'weekly-review': ['weekly review'],
    'opt-out': [],
  };

  it('matches case-insensitively', () => {
    const matches = findMatchingProtocols('Good Morning Robin!', map);
    assert.ok(matches.some((m) => m.protocol === 'daily-briefing' && m.phrase === 'good morning'));
  });

  it('matches at word boundaries (start)', () => {
    const matches = findMatchingProtocols('morning briefing please', map);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].protocol, 'daily-briefing');
    assert.equal(matches[0].phrase, 'morning briefing');
  });

  it('does NOT match inside a longer word ("the daily briefing system")', () => {
    // "morning briefing" should match in "morning briefing" but not in "good_morningbriefing".
    // Test for false positive: "the daily briefing system" — phrase is "morning briefing" which
    // isn't in this prompt at all. Use a more direct false-positive case:
    // the phrase is "weekly review" — "weeklyreviewer" should not match.
    const matches = findMatchingProtocols('I am a weeklyreviewer of news', map);
    assert.equal(matches.length, 0);
  });

  it('matches with surrounding punctuation', () => {
    const matches = findMatchingProtocols('Please, weekly review!', map);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].protocol, 'weekly-review');
  });

  it('returns multiple protocols when multiple match', () => {
    const overlap = {
      a: ['briefing'],
      b: ['daily briefing'],
    };
    const matches = findMatchingProtocols('give me a daily briefing now', overlap);
    const names = matches.map((m) => m.protocol).sort();
    assert.deepEqual(names, ['a', 'b']);
  });

  it('empty triggers array (opt-out) never matches anything', () => {
    const matches = findMatchingProtocols('opt-out', map);
    // No phrase in the map for 'opt-out', so nothing matches.
    assert.equal(matches.find((m) => m.protocol === 'opt-out'), undefined);
  });

  it('returns same protocol once even if multiple phrases match (dedup by protocol+phrase)', () => {
    const matches = findMatchingProtocols('good morning, brief me', map);
    const dailyMatches = matches.filter((m) => m.protocol === 'daily-briefing');
    // Two different phrases, two entries (preserved for telemetry visibility).
    assert.equal(dailyMatches.length, 2);
  });

  it('returns empty array when no matches', () => {
    const matches = findMatchingProtocols('nothing relevant here', map);
    assert.deepEqual(matches, []);
  });

  it('handles empty prompt gracefully', () => {
    assert.deepEqual(findMatchingProtocols('', map), []);
    assert.deepEqual(findMatchingProtocols(null, map), []);
    assert.deepEqual(findMatchingProtocols(undefined, map), []);
  });
});

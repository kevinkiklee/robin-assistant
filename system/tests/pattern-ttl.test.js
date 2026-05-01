import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFirings,
  truncateFirings,
  processPatternTTL,
  DEFAULT_TTL_DAYS,
  __test__,
} from '../scripts/lib/pattern-ttl.js';

function ws() { return mkdtempSync(join(tmpdir(), 'ttl-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function writeLog(workspaceDir, content) {
  mkdirSync(join(workspaceDir, 'user-data/state'), { recursive: true });
  writeFileSync(join(workspaceDir, 'user-data/state/pattern-firings.log'), content);
}

function writePatterns(workspaceDir, content) {
  mkdirSync(join(workspaceDir, 'user-data/memory/self-improvement'), { recursive: true });
  writeFileSync(join(workspaceDir, 'user-data/memory/self-improvement/patterns.md'), content);
}

test('readFirings: empty / missing log returns empty Map', () => {
  const w = ws();
  try {
    assert.equal(readFirings(w).size, 0);
  } finally {
    clean(w);
  }
});

test('readFirings: aggregates firings by name', () => {
  const w = ws();
  try {
    writeLog(w, [
      '2026-04-30T14:00:00Z\tpattern-A',
      '2026-04-30T15:00:00Z\tpattern-A',
      '2026-04-30T16:00:00Z\tpattern-B',
      '',
    ].join('\n'));
    const m = readFirings(w);
    assert.equal(m.get('pattern-A').count, 2);
    assert.equal(m.get('pattern-A').lastDate, '2026-04-30');
    assert.equal(m.get('pattern-B').count, 1);
  } finally {
    clean(w);
  }
});

test('truncateFirings: empties the log', () => {
  const w = ws();
  try {
    writeLog(w, '2026-04-30T00:00:00Z\tx\n');
    truncateFirings(w);
    const after = readFileSync(join(w, 'user-data/state/pattern-firings.log'), 'utf-8');
    assert.equal(after, '');
  } finally {
    clean(w);
  }
});

test('processPatternTTL: updates last_fired + fired_count from log', () => {
  const w = ws();
  try {
    writePatterns(w, `# Patterns

## Tendency to hedge
---
name: tendency-to-hedge
last_fired: 2026-01-01
fired_count: 3
---
body of pattern.
`);
    writeLog(w, '2026-04-30T15:00:00Z\ttendency-to-hedge\n');

    const summary = processPatternTTL(w, { now: '2026-04-30' });
    assert.equal(summary.updated, 1);
    assert.equal(summary.archived, 0);
    assert.equal(summary.fired_count_total, 1);

    const after = readFileSync(join(w, 'user-data/memory/self-improvement/patterns.md'), 'utf-8');
    assert.match(after, /last_fired: 2026-04-30/);
    assert.match(after, /fired_count: 4/);

    // Log truncated.
    const log = readFileSync(join(w, 'user-data/state/pattern-firings.log'), 'utf-8');
    assert.equal(log, '');
  } finally {
    clean(w);
  }
});

test('processPatternTTL: archives patterns past TTL', () => {
  const w = ws();
  try {
    writePatterns(w, `# Patterns

## Stale pattern
---
name: stale
last_fired: 2025-01-01
fired_count: 2
---
body
`);
    const summary = processPatternTTL(w, { now: '2026-04-30' });
    assert.equal(summary.archived, 1);

    const patterns = readFileSync(join(w, 'user-data/memory/self-improvement/patterns.md'), 'utf-8');
    assert.doesNotMatch(patterns, /Stale pattern/);

    const archive = readFileSync(join(w, 'user-data/memory/self-improvement/patterns-archive.md'), 'utf-8');
    assert.match(archive, /Stale pattern/);
    assert.match(archive, /archived_at: 2026-04-30/);
    assert.match(archive, /TTL exceeded/);
  } finally {
    clean(w);
  }
});

test('processPatternTTL: per-pattern ttl_days override is respected', () => {
  const w = ws();
  try {
    writePatterns(w, `# Patterns

## Long-lived pattern
---
name: long
last_fired: 2025-01-01
fired_count: 2
ttl_days: 999
---
body
`);
    const summary = processPatternTTL(w, { now: '2026-04-30' });
    assert.equal(summary.archived, 0, 'ttl_days override should keep this pattern');
  } finally {
    clean(w);
  }
});

test('processPatternTTL: no patterns file → no-op summary', () => {
  const w = ws();
  try {
    const summary = processPatternTTL(w);
    assert.equal(summary.updated, 0);
    assert.equal(summary.archived, 0);
  } finally {
    clean(w);
  }
});

test('parsePatterns/serializePatterns: round-trip preserves structure', () => {
  const md = `intro\n## P1\n---\nname: p1\nlast_fired: 2026-04-30\n---\nbody p1\n`;
  const parsed = __test__.parsePatterns(md);
  const out = __test__.serializePatterns(parsed);
  assert.match(out, /## P1/);
  assert.match(out, /name: p1/);
  assert.match(out, /body p1/);
});

test('daysBetween: handles missing dates → infinity', () => {
  assert.equal(__test__.daysBetween('', '2026-04-30'), Infinity);
  assert.equal(__test__.daysBetween('2026-04-30', ''), Infinity);
  assert.equal(__test__.daysBetween('2026-04-29', '2026-04-30'), 1);
});

test('DEFAULT_TTL_DAYS is 180', () => {
  assert.equal(DEFAULT_TTL_DAYS, 180);
});

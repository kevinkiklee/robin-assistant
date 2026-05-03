import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffDreamReturns, evaluateSoakWindow } from '../../scripts/lib/dream-shadow-diff.js';

describe('diffDreamReturns', () => {
  it('returns matches=true and no issues for identical returns', () => {
    const sub = { routed_count: 5, notable: ['a', 'b'], errors: [], tier1_touched: ['x.md'] };
    const inl = { routed_count: 5, notable: ['a', 'b'], errors: [], tier1_touched: ['x.md'] };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.matches, true);
    assert.equal(result.severity, 'none');
    assert.deepEqual(result.issues, []);
  });

  it('treats notable order-insensitively', () => {
    const sub = { routed_count: 3, notable: ['a', 'b', 'c'], errors: [], tier1_touched: [] };
    const inl = { routed_count: 3, notable: ['c', 'a', 'b'], errors: [], tier1_touched: [] };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.matches, true);
  });

  it('flags routed_count mismatch as major', () => {
    const sub = { routed_count: 5, notable: [], errors: [], tier1_touched: [] };
    const inl = { routed_count: 7, notable: [], errors: [], tier1_touched: [] };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.matches, false);
    assert.equal(result.severity, 'major');
    assert.equal(result.issues[0].field, 'routed_count');
  });

  it('flags one notable difference as minor, multiple as major', () => {
    const sub1 = { routed_count: 1, notable: ['a', 'b', 'c'], errors: [], tier1_touched: [] };
    const inl1 = { routed_count: 1, notable: ['a', 'b'], errors: [], tier1_touched: [] };
    const r1 = diffDreamReturns(sub1, inl1);
    assert.equal(r1.severity, 'minor');

    const sub2 = { routed_count: 1, notable: ['a', 'b', 'c', 'd'], errors: [], tier1_touched: [] };
    const inl2 = { routed_count: 1, notable: ['a'], errors: [], tier1_touched: [] };
    const r2 = diffDreamReturns(sub2, inl2);
    assert.equal(r2.severity, 'major');
  });

  it('flags any error mismatch as major', () => {
    const sub = { routed_count: 5, notable: [], errors: ['fail-a'], tier1_touched: [] };
    const inl = { routed_count: 5, notable: [], errors: [], tier1_touched: [] };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.severity, 'major');
    assert.equal(result.issues[0].field, 'errors');
  });

  it('flags tier1_touched divergence as major', () => {
    const sub = { routed_count: 1, notable: [], errors: [], tier1_touched: ['a.md'] };
    const inl = { routed_count: 1, notable: [], errors: [], tier1_touched: ['b.md'] };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.severity, 'major');
    assert.equal(result.issues[0].field, 'tier1_touched');
  });

  it('handles missing optional fields (treats as empty arrays)', () => {
    const sub = { routed_count: 0 };
    const inl = { routed_count: 0 };
    const result = diffDreamReturns(sub, inl);
    assert.equal(result.matches, true);
  });
});

describe('evaluateSoakWindow', () => {
  it('passes when last 7 days are all clean', () => {
    const days = Array(7).fill({ severity: 'none' });
    const result = evaluateSoakWindow(days);
    assert.equal(result.passes, true);
    assert.equal(result.cleanDays, 7);
  });

  it('passes with minor severities (only major fails)', () => {
    const days = [
      { severity: 'none' }, { severity: 'minor' }, { severity: 'none' },
      { severity: 'minor' }, { severity: 'none' }, { severity: 'none' },
      { severity: 'none' },
    ];
    const result = evaluateSoakWindow(days);
    assert.equal(result.passes, true);
    assert.equal(result.minorDays, 2);
    assert.equal(result.cleanDays, 5);
  });

  it('fails when any of last 7 days is major', () => {
    const days = Array(6).fill({ severity: 'none' }).concat([{ severity: 'major' }]);
    const result = evaluateSoakWindow(days);
    assert.equal(result.passes, false);
    assert.equal(result.majorDays, 1);
  });

  it('fails when fewer than 7 days provided', () => {
    const result = evaluateSoakWindow([{ severity: 'none' }]);
    assert.equal(result.passes, false);
    assert.match(result.reason, /insufficient days/);
  });

  it('only considers the LAST 7 days when more provided', () => {
    // First 3 days have major issues; last 7 are clean
    const days = [
      { severity: 'major' }, { severity: 'major' }, { severity: 'major' },
      { severity: 'none' }, { severity: 'none' }, { severity: 'none' }, { severity: 'none' },
      { severity: 'none' }, { severity: 'none' }, { severity: 'none' },
    ];
    const result = evaluateSoakWindow(days);
    assert.equal(result.passes, true, 'last 7 days clean → pass');
  });
});

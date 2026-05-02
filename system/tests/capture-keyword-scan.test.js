// system/tests/capture-keyword-scan.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanEntityAliases } from '../scripts/lib/capture-keyword-scan.js';

describe('scanEntityAliases', () => {
  it('returns [] for empty alias list', () => {
    assert.deepEqual(scanEntityAliases('hello world', []), []);
  });

  it('matches alias case-insensitively, returns canonical form', () => {
    assert.deepEqual(
      scanEntityAliases('meeting with dr. park tomorrow', ['Dr. Park']),
      ['Dr. Park'],
    );
  });

  it('respects word boundaries', () => {
    assert.deepEqual(scanEntityAliases('parker is here', ['Park']), []);
  });

  it('deduplicates multiple hits to one canonical entry', () => {
    assert.deepEqual(
      scanEntityAliases('Park called. Then PARK left.', ['Park']),
      ['Park'],
    );
  });

  it('escapes regex metacharacters in aliases (no crash)', () => {
    // Brackets/parens in aliases must be escaped, otherwise the regex throws.
    // Match isn't expected here (closing ) breaks the right \b), but the call
    // must not throw.
    assert.doesNotThrow(() =>
      scanEntityAliases('paid via Lunch Money today', ['Lunch Money (banking)']),
    );
  });
});

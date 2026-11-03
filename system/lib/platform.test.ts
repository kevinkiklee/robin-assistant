import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePlatforms, platformSkipLabel, runsOnThisPlatform } from './platform.ts';

describe('runsOnThisPlatform', () => {
  const table: Array<[string[] | undefined, string, boolean]> = [
    [undefined, 'linux', true],
    [[], 'linux', true],
    [['darwin'], 'darwin', true],
    [['darwin'], 'linux', false],
    [['linux'], 'darwin', false],
    [['darwin', 'linux'], 'linux', true],
  ];
  for (const [platforms, platform, want] of table) {
    it(`${JSON.stringify(platforms)} on ${platform} -> ${want}`, () => {
      assert.equal(runsOnThisPlatform({ platforms }, platform), want);
    });
  }
  it('defaults to process.platform', () => {
    assert.equal(runsOnThisPlatform({ platforms: [process.platform] }), true);
  });
});

describe('parsePlatforms', () => {
  it('accepts a valid list', () => {
    assert.deepEqual(parsePlatforms(['darwin']), ['darwin']);
  });
  it('ignores and warns on invalid values, never throws', () => {
    for (const bad of ['darwin', ['windows'], [], [1], { a: 1 }]) {
      const warnings: string[] = [];
      assert.equal(
        parsePlatforms(bad, (m) => warnings.push(m)),
        undefined,
      );
      assert.equal(warnings.length, 1);
    }
  });
  it('absent is silent', () => {
    const warnings: string[] = [];
    assert.equal(
      parsePlatforms(undefined, (m) => warnings.push(m)),
      undefined,
    );
    assert.equal(warnings.length, 0);
  });
});

describe('platformSkipLabel', () => {
  it('uses the exact copy', () => {
    assert.equal(
      platformSkipLabel({ platforms: ['darwin'] }),
      'skipped — darwin-only (needs the Mac; satellite pending)',
    );
    assert.equal(platformSkipLabel({ platforms: ['linux'] }), 'skipped — linux-only');
  });
});

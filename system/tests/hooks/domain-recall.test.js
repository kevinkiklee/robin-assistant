// Unit tests for system/scripts/hooks/lib/domain-recall.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDomainMap,
  loadDomainMap,
  matchDomains,
  formatDomainHits,
  runDomainRecall,
} from '../../scripts/hooks/lib/domain-recall.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dr-'));
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/knowledge/home'), { recursive: true });
  return dir;
}

const SAMPLE_MAP = `---
description: Recall domains
type: reference
---

# Recall domains

## gardening
keywords: garden, gardening, plant, fertilizer
files:
  - user-data/memory/knowledge/home/outdoor-space.md

## finance
keywords: IRA, Roth, 401k
files:
  - user-data/memory/knowledge/finance/financial-snapshot.md

## empty section (no keywords)
files:
  - user-data/memory/should-skip.md
`;

describe('domain-recall', () => {
  describe('parseDomainMap', () => {
    it('parses sections with keywords + files', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      assert.equal(map.length, 2);
      assert.equal(map[0].domain, 'gardening');
      assert.deepEqual(map[0].keywords, ['garden', 'gardening', 'plant', 'fertilizer']);
      assert.deepEqual(map[0].files, ['user-data/memory/knowledge/home/outdoor-space.md']);
      assert.equal(map[1].domain, 'finance');
    });

    it('skips sections missing keywords', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const names = map.map((d) => d.domain);
      assert.ok(!names.includes('empty section (no keywords)'));
    });

    it('returns [] for empty input', () => {
      assert.deepEqual(parseDomainMap(''), []);
      assert.deepEqual(parseDomainMap(null), []);
    });

    it('returns [] for malformed map (no sections)', () => {
      assert.deepEqual(parseDomainMap('# just a heading\nno sections\n'), []);
    });

    it('handles a section with no `files:` block', () => {
      const text = `## nofiles\nkeywords: foo\n`;
      assert.deepEqual(parseDomainMap(text), []);
    });
  });

  describe('matchDomains', () => {
    it('matches a single keyword case-insensitively', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const r = matchDomains('what FERTILIZER should I use?', map);
      assert.deepEqual(r.files, ['user-data/memory/knowledge/home/outdoor-space.md']);
      assert.deepEqual(r.domainsMatched, ['gardening']);
    });

    it('uses word boundaries (no partial-word match)', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const r = matchDomains('mortgage planning', map);
      // "planning" should not match the "plant" keyword.
      assert.deepEqual(r.files, []);
    });

    it('returns multiple files when multiple domains match', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const r = matchDomains('Roth IRA garden talk', map);
      assert.equal(r.files.length, 2);
      assert.deepEqual(r.domainsMatched, ['gardening', 'finance']);
    });

    it('dedupes against excludeFiles', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const r = matchDomains('fertilizer please', map, {
        excludeFiles: ['user-data/memory/knowledge/home/outdoor-space.md'],
      });
      assert.deepEqual(r.files, []);
      assert.deepEqual(r.domainsMatched, ['gardening']);
    });

    it('returns empty when text is empty', () => {
      const map = parseDomainMap(SAMPLE_MAP);
      const r = matchDomains('', map);
      assert.deepEqual(r.files, []);
    });

    it('returns empty when domain map is empty', () => {
      const r = matchDomains('garden talk', []);
      assert.deepEqual(r.files, []);
    });
  });

  describe('loadDomainMap', () => {
    it('returns [] when file is missing', () => {
      const ws = makeWorkspace();
      assert.deepEqual(loadDomainMap(ws), []);
    });

    it('loads and parses the file when present', () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), SAMPLE_MAP);
      const map = loadDomainMap(ws);
      assert.equal(map.length, 2);
    });
  });

  describe('formatDomainHits', () => {
    it('returns empty when no files exist', () => {
      const ws = makeWorkspace();
      const out = formatDomainHits(ws, ['user-data/memory/missing.md']);
      assert.equal(out, '');
    });

    it('inlines file contents under the path', () => {
      const ws = makeWorkspace();
      writeFileSync(
        join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
        '# Outdoor space\n\nrooftop garden, sunflowers\n',
      );
      const out = formatDomainHits(ws, ['user-data/memory/knowledge/home/outdoor-space.md']);
      assert.match(out, /user-data\/memory\/knowledge\/home\/outdoor-space\.md:/);
      assert.match(out, /sunflowers/);
    });

    it('truncates files over maxBytesPerFile', () => {
      const ws = makeWorkspace();
      const big = 'x'.repeat(5000);
      writeFileSync(join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'), big);
      const out = formatDomainHits(
        ws,
        ['user-data/memory/knowledge/home/outdoor-space.md'],
        { maxBytesPerFile: 100 },
      );
      assert.match(out, /…\(truncated\)/);
    });
  });

  describe('runDomainRecall (one-shot)', () => {
    it('returns block when match present and file exists', () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), SAMPLE_MAP);
      writeFileSync(
        join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
        '# Outdoor space\nrooftop garden\n',
      );
      const r = runDomainRecall(ws, 'what fertilizer should I use this spring?');
      assert.match(r.block, /<!-- relevant memory: 1 files for domain match: gardening -->/);
      assert.match(r.block, /rooftop garden/);
      assert.equal(r.files.length, 1);
      assert.deepEqual(r.domainsMatched, ['gardening']);
      assert.ok(r.bytes > 0);
    });

    it('returns empty block when no match', () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), SAMPLE_MAP);
      const r = runDomainRecall(ws, 'tell me about cats');
      assert.equal(r.block, '');
      assert.equal(r.files.length, 0);
    });

    it('is a no-op when domain map is missing', () => {
      const ws = makeWorkspace();
      const r = runDomainRecall(ws, 'fertilizer please');
      assert.equal(r.block, '');
    });

    it('respects excludeFiles (no double-inject)', () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), SAMPLE_MAP);
      writeFileSync(
        join(ws, 'user-data/memory/knowledge/home/outdoor-space.md'),
        'body\n',
      );
      const r = runDomainRecall(ws, 'fertilizer please', {
        excludeFiles: ['user-data/memory/knowledge/home/outdoor-space.md'],
      });
      assert.equal(r.block, '');
      assert.equal(r.files.length, 0);
    });
  });
});

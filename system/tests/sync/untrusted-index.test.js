import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fnv1a64,
  splitSentences,
  updateIndexForFile,
  loadOrRefreshIndex,
  findSourceForHash,
} from '../../scripts/sync/lib/untrusted-index.js';

function ws() { return mkdtempSync(join(tmpdir(), 'idx-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

test('fnv1a64: deterministic and 16-char hex', () => {
  const h = fnv1a64('hello world');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(fnv1a64('hello world'), h);
});

test('fnv1a64: different inputs produce different hashes', () => {
  assert.notEqual(fnv1a64('abc'), fnv1a64('abd'));
});

test('splitSentences: drops sentences <20 chars', () => {
  const out = splitSentences('Short. Another short. This sentence is exactly long enough to count.');
  assert.equal(out.some(s => s === 'short'), false);
  // Sentences are normalized to lowercase.
  assert.equal(out.some(s => /this sentence is exactly long enough/.test(s)), true);
});

test('splitSentences: splits on sentence terminators, paragraphs, list items, table cells', () => {
  const text = `First sentence is at least twenty chars. Second sentence is also long enough.

A paragraph break creates a new sentence.

- List item that is at least twenty chars long.
| table cell that is also long enough |`;
  const out = splitSentences(text);
  assert.ok(out.length >= 4);
});

test('splitSentences: strips frontmatter and UNTRUSTED markers', () => {
  const text = `---
description: x
trust: untrusted
---

<!-- UNTRUSTED-START src=sync-gmail -->
This is the actual content that should be hashed.
<!-- UNTRUSTED-END -->`;
  const out = splitSentences(text);
  assert.equal(out.some(s => /actual content that should be hashed/.test(s)), true);
  assert.equal(out.some(s => /trust: untrusted/.test(s)), false);
  assert.equal(out.some(s => /untrusted-start/i.test(s)), false);
});

test('updateIndexForFile + loadOrRefreshIndex: round-trip', () => {
  const w = ws();
  try {
    const path = 'user-data/memory/knowledge/email/inbox-snapshot.md';
    mkdirSync(join(w, 'user-data/memory/knowledge/email'), { recursive: true });
    const content = 'A sentence that is at least twenty characters long.';
    writeFileSync(join(w, path), content);
    updateIndexForFile(w, path, content);
    const idx = loadOrRefreshIndex(w);
    assert.equal(Object.keys(idx.sources).length, 1);
    assert.equal(idx.allHashes.size, 1);
  } finally {
    clean(w);
  }
});

test('loadOrRefreshIndex: mtime change triggers rebuild', () => {
  const w = ws();
  try {
    const rel = 'user-data/memory/test/x.md';
    mkdirSync(join(w, 'user-data/memory/test'), { recursive: true });
    writeFileSync(join(w, rel), 'Original sentence at least twenty chars wide.');
    updateIndexForFile(w, rel, 'Original sentence at least twenty chars wide.');
    const before = loadOrRefreshIndex(w);
    const beforeHash = [...before.allHashes][0];

    // Modify file content + mtime.
    writeFileSync(join(w, rel), 'Modified sentence at least twenty chars wide.');
    const future = (Date.now() + 5000) / 1000;
    utimesSync(join(w, rel), future, future);

    const after = loadOrRefreshIndex(w);
    const afterHash = [...after.allHashes][0];
    assert.notEqual(beforeHash, afterHash);
  } finally {
    clean(w);
  }
});

test('loadOrRefreshIndex: drops entries for deleted source files', () => {
  const w = ws();
  try {
    const rel = 'user-data/memory/test/y.md';
    mkdirSync(join(w, 'user-data/memory/test'), { recursive: true });
    writeFileSync(join(w, rel), 'Content for the test sentence here, twenty plus chars.');
    updateIndexForFile(w, rel, 'Content for the test sentence here, twenty plus chars.');

    rmSync(join(w, rel));
    const idx = loadOrRefreshIndex(w);
    assert.equal(Object.keys(idx.sources).length, 0);
    assert.equal(idx.allHashes.size, 0);
  } finally {
    clean(w);
  }
});

test('loadOrRefreshIndex: missing index file returns empty', () => {
  const w = ws();
  try {
    const idx = loadOrRefreshIndex(w);
    assert.equal(idx.sources && Object.keys(idx.sources).length, 0);
    assert.equal(idx.allHashes.size, 0);
  } finally {
    clean(w);
  }
});

test('findSourceForHash: returns path or null', () => {
  const w = ws();
  try {
    const rel = 'user-data/memory/test/z.md';
    mkdirSync(join(w, 'user-data/memory/test'), { recursive: true });
    const content = 'Specific phrase that should be findable across the haystack.';
    writeFileSync(join(w, rel), content);
    updateIndexForFile(w, rel, content);
    const idx = loadOrRefreshIndex(w);
    const someHash = [...idx.allHashes][0];
    assert.equal(findSourceForHash({ sources: idx.sources }, someHash), rel);
    assert.equal(findSourceForHash({ sources: idx.sources }, 'deadbeefdeadbeef'), null);
  } finally {
    clean(w);
  }
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { captureTree, compareTrees, writeTreeAtomic } from './snapshot.js';

describe('snapshot', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'snap-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captureTree returns map of relpath → text', () => {
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'a/b/c.md'), 'hello');
    writeFileSync(join(root, 'top.md'), 'world');
    const tree = captureTree(root, []);
    assert.deepEqual(tree, { 'a/b/c.md': 'hello', 'top.md': 'world' });
  });

  it('captureTree skips ignored globs', () => {
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(join(root, 'logs/perf.log'), 'ignored');
    writeFileSync(join(root, 'kept.md'), 'kept');
    const tree = captureTree(root, ['logs/**']);
    assert.deepEqual(tree, { 'kept.md': 'kept' });
  });

  it('captureTree throws on binary file', () => {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0x00, 0xff, 0x00, 0xff]));
    assert.throws(() => captureTree(root, []), /binary/i);
  });

  it('compareTrees returns missing/unexpected/content lists', () => {
    const expected = { 'a.md': 'A', 'b.md': 'B' };
    const actual = { 'a.md': 'A', 'c.md': 'C' }; // missing b, unexpected c
    const diff = compareTrees(actual, expected);
    assert.deepEqual(diff.missing, ['b.md']);
    assert.deepEqual(diff.unexpected, ['c.md']);
    assert.deepEqual(diff.contentDiffs, []);
  });

  it('compareTrees flags content diffs', () => {
    const diff = compareTrees({ 'a.md': 'A1' }, { 'a.md': 'A2' });
    assert.equal(diff.contentDiffs.length, 1);
    assert.equal(diff.contentDiffs[0].relpath, 'a.md');
  });

  it('writeTreeAtomic rebuilds target dir', () => {
    const target = join(root, 'expected/tree');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'old.md'), 'will be deleted');
    writeTreeAtomic(target, { 'a.md': 'A', 'sub/b.md': 'B' });
    assert.equal(existsSync(join(target, 'old.md')), false);
    assert.equal(readFileSync(join(target, 'a.md'), 'utf8'), 'A');
    assert.equal(readFileSync(join(target, 'sub/b.md'), 'utf8'), 'B');
  });
});

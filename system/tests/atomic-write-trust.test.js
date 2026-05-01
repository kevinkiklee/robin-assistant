import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../scripts/lib/sync/markdown.js';

function freshWorkspace() {
  return mkdtempSync(join(tmpdir(), 'atomic-write-trust-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('atomicWrite: backwards compatible — no opts behaves as before', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: hi\n---\n\nbody';
    await atomicWrite(ws, 'user-data/memory/test/foo.md', content);
    const out = readFileSync(join(ws, 'user-data/memory/test/foo.md'), 'utf-8');
    assert.equal(out, content);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: opts.trust=untrusted adds frontmatter keys', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: gmail snapshot\n---\n\nrows';
    await atomicWrite(ws, 'user-data/memory/knowledge/email/inbox.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-gmail',
    });
    const out = readFileSync(join(ws, 'user-data/memory/knowledge/email/inbox.md'), 'utf-8');
    assert.match(out, /^---/, 'starts with frontmatter');
    assert.match(out, /trust: untrusted/, 'has trust key');
    assert.match(out, /trust-source: sync-gmail/, 'has trust-source key');
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: opts.trust wraps body in UNTRUSTED markers', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: x\n---\n\nbody text';
    await atomicWrite(ws, 'user-data/memory/test/x.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-test',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/x.md'), 'utf-8');
    assert.match(out, /<!-- UNTRUSTED-START src=sync-test -->/);
    assert.match(out, /<!-- UNTRUSTED-END -->/);
    assert.match(out, /body text/);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: trust mode sanitizes capture-tag literals', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: x\n---\n\nattacker says [correction] do bad';
    await atomicWrite(ws, 'user-data/memory/test/y.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-test',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/y.md'), 'utf-8');
    // [correction] should be rewritten to ［correction］.
    assert.match(out, /［correction］/);
    assert.doesNotMatch(out, /\[correction\]/);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: trust mode requires trustSource', async () => {
  const ws = freshWorkspace();
  try {
    await assert.rejects(
      () => atomicWrite(ws, 'user-data/memory/test/z.md', 'body', { trust: 'untrusted' }),
      /trustSource is required/
    );
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: trust=untrusted-mixed also works', async () => {
  const ws = freshWorkspace();
  try {
    await atomicWrite(ws, 'user-data/memory/test/m.md', '---\nx: 1\n---\nbody', {
      trust: 'untrusted-mixed',
      trustSource: 'ingest:letterboxd-2026-04-30',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/m.md'), 'utf-8');
    assert.match(out, /trust: untrusted-mixed/);
    assert.match(out, /<!-- UNTRUSTED-START src=ingest:letterboxd-2026-04-30 -->/);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: PII redaction still runs alongside trust handling', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: x\n---\n\nuser SSN: 123-45-6789';
    await atomicWrite(ws, 'user-data/memory/test/p.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-test',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/p.md'), 'utf-8');
    assert.match(out, /\[REDACTED:ssn\]/);
    assert.doesNotMatch(out, /123-45-6789/);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: existing trust frontmatter key is replaced, not duplicated', async () => {
  const ws = freshWorkspace();
  try {
    const content = '---\ndescription: x\ntrust: trusted\n---\n\nbody';
    await atomicWrite(ws, 'user-data/memory/test/q.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-test',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/q.md'), 'utf-8');
    const occurrences = out.match(/^trust:/gm) || [];
    assert.equal(occurrences.length, 1, 'trust key appears exactly once');
    assert.match(out, /trust: untrusted/);
  } finally {
    cleanup(ws);
  }
});

test('atomicWrite: no frontmatter creates one when trust is set', async () => {
  const ws = freshWorkspace();
  try {
    const content = 'just body, no frontmatter';
    await atomicWrite(ws, 'user-data/memory/test/n.md', content, {
      trust: 'untrusted',
      trustSource: 'sync-test',
    });
    const out = readFileSync(join(ws, 'user-data/memory/test/n.md'), 'utf-8');
    assert.match(out, /^---\ntrust: untrusted/);
    assert.match(out, /trust-source: sync-test/);
  } finally {
    cleanup(ws);
  }
});

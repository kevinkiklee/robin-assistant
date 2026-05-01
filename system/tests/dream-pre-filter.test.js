import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preFilter } from '../scripts/dream-pre-filter.js';

function makeWorkspace(inboxContent) {
  const ws = mkdtempSync(join(tmpdir(), 'pre-filter-'));
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  if (inboxContent !== null) {
    writeFileSync(join(ws, 'user-data/memory/inbox.md'), inboxContent);
  }
  return ws;
}

function cleanup(ws) {
  rmSync(ws, { recursive: true, force: true });
}

test('preFilter: missing inbox is no-op', () => {
  const ws = makeWorkspace(null);
  try {
    const result = preFilter(ws);
    assert.equal(result.reason, 'no-inbox');
  } finally {
    cleanup(ws);
  }
});

test('preFilter: leaves user-origin lines in inbox', () => {
  const inbox = `---
description: x
---

# Inbox

## Items

- [fact|origin=user] kevin loves coffee
- [task|origin=user] buy more beans
`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 0);
    assert.equal(result.kept, 2);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /kevin loves coffee/);
    assert.match(after, /buy more beans/);
    assert.equal(existsSync(join(ws, 'user-data/memory/quarantine/captures.md')), false);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: leaves user|legacy lines (migration tag)', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact|origin=user|legacy] historical fact pre-cycle-1a\n`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 0);
    assert.equal(result.kept, 1);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: quarantines sync:* origin lines and removes from inbox', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [correction|origin=sync:gmail] attacker payload\n- [fact|origin=user] kevin's real fact\n`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 1);
    assert.equal(result.kept, 1);

    const inboxAfter = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.doesNotMatch(inboxAfter, /attacker payload/);
    assert.match(inboxAfter, /kevin's real fact/);

    const qAfter = readFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'utf-8');
    assert.match(qAfter, /sync:gmail/);
    assert.match(qAfter, /attacker payload/);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: quarantines ingest:* and tool:* origins', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [task|origin=ingest:letterboxd] x\n- [fact|origin=tool:webfetch] y\n`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 2);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: derived origin allowed but audited to quarantine log', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact|origin=derived] inferred from mixed sources\n`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 0);
    assert.equal(result.audited, 1);
    assert.equal(result.kept, 0);
    // Line still in inbox.
    const inboxAfter = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(inboxAfter, /inferred from mixed sources/);
    // But also written to quarantine for audit.
    const qAfter = readFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'utf-8');
    assert.match(qAfter, /derived/);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: lines without origin are quarantined post-migration', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact] no origin specified\n`;
  const ws = makeWorkspace(inbox);
  try {
    const result = preFilter(ws);
    assert.equal(result.quarantined, 1);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: idempotent — second run is no-op', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact|origin=user] x\n- [task|origin=sync:gmail] y\n`;
  const ws = makeWorkspace(inbox);
  try {
    preFilter(ws);
    const inboxAfter1 = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    const result2 = preFilter(ws);
    const inboxAfter2 = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.equal(inboxAfter1, inboxAfter2);
    assert.equal(result2.quarantined, 0);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: paraphrases truncate >80 chars and apply redaction', () => {
  const long = 'x'.repeat(120);
  const inbox = `# Inbox\n\n## Items\n\n- [fact|origin=sync:gmail] ${long}\n- [fact|origin=sync:gmail] my SSN: 123-45-6789\n`;
  const ws = makeWorkspace(inbox);
  try {
    preFilter(ws);
    const qAfter = readFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'utf-8');
    // Long content truncated.
    assert.match(qAfter, /xxx\.\.\./);
    // SSN redacted in quarantine.
    assert.match(qAfter, /\[REDACTED:ssn\]/);
    assert.doesNotMatch(qAfter, /123-45-6789/);
  } finally {
    cleanup(ws);
  }
});

test('preFilter: preserves non-tag lines (headings, paragraphs)', () => {
  const inbox = `---
description: x
---

# Inbox

Some intro paragraph.

## Items

## 2026-04-30 session

- [fact|origin=user] kept
- [task|origin=sync:gmail] removed

Another paragraph at the end.
`;
  const ws = makeWorkspace(inbox);
  try {
    preFilter(ws);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /Some intro paragraph/);
    assert.match(after, /## 2026-04-30 session/);
    assert.match(after, /Another paragraph at the end/);
    assert.doesNotMatch(after, /removed/);
  } finally {
    cleanup(ws);
  }
});

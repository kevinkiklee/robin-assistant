import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateCycle1a } from '../scripts/migrate-cycle-1a.js';

function makeWorkspace(inboxContent) {
  const ws = mkdtempSync(join(tmpdir(), 'migrate-1a-'));
  if (inboxContent !== null) {
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    writeFileSync(join(ws, 'user-data/memory/inbox.md'), inboxContent);
  }
  return ws;
}

function cleanup(ws) {
  rmSync(ws, { recursive: true, force: true });
}

test('migrate-cycle-1a: stamps unstamped tag lines with origin=user|legacy', () => {
  const ws = makeWorkspace(`# Inbox\n\n## Items\n\n- [fact] foo\n- [task] bar\n`);
  try {
    const result = migrateCycle1a(ws);
    assert.equal(result.inbox.stamped, 2);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /\[fact\|origin=user\|legacy\] foo/);
    assert.match(after, /\[task\|origin=user\|legacy\] bar/);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: leaves already-tagged lines alone (idempotent)', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact|origin=user] already tagged\n`;
  const ws = makeWorkspace(inbox);
  try {
    const r1 = migrateCycle1a(ws);
    assert.equal(r1.inbox.stamped, 0);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /\[fact\|origin=user\] already tagged/);
    // Run again — still 0 stamped.
    const r2 = migrateCycle1a(ws);
    assert.equal(r2.inbox.stamped, 0);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: preserves non-tag lines', () => {
  const inbox = `---
description: x
---
# Inbox

Some intro text.

## 2026-04-30 session

- [fact] first
- [correction] second
`;
  const ws = makeWorkspace(inbox);
  try {
    migrateCycle1a(ws);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /Some intro text/);
    assert.match(after, /## 2026-04-30 session/);
    assert.match(after, /\[fact\|origin=user\|legacy\] first/);
    assert.match(after, /\[correction\|origin=user\|legacy\] second/);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: creates quarantine file when absent', () => {
  const ws = makeWorkspace('# Inbox\n');
  try {
    const result = migrateCycle1a(ws);
    assert.equal(result.quarantine.created, true);
    assert.equal(existsSync(join(ws, 'user-data/memory/quarantine/captures.md')), true);
    const q = readFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'utf-8');
    assert.match(q, /Captures Quarantine/);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: leaves existing quarantine file alone', () => {
  const ws = makeWorkspace('# Inbox\n');
  try {
    mkdirSync(join(ws, 'user-data/memory/quarantine'), { recursive: true });
    writeFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'EXISTING\n');
    const result = migrateCycle1a(ws);
    assert.equal(result.quarantine.created, false);
    const q = readFileSync(join(ws, 'user-data/memory/quarantine/captures.md'), 'utf-8');
    assert.equal(q, 'EXISTING\n');
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: stamps lines with secondary tag prefix', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [correction] [movies] kevin watched The Fountain\n`;
  const ws = makeWorkspace(inbox);
  try {
    migrateCycle1a(ws);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    assert.match(after, /\[correction\|origin=user\|legacy\] \[movies\] kevin watched/);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: preserves existing modifier (e.g., [fact|something])', () => {
  const inbox = `# Inbox\n\n## Items\n\n- [fact|verified] x\n`;
  const ws = makeWorkspace(inbox);
  try {
    migrateCycle1a(ws);
    const after = readFileSync(join(ws, 'user-data/memory/inbox.md'), 'utf-8');
    // Should append origin to existing modifier
    assert.match(after, /\[fact\|verified\|origin=user\|legacy\] x/);
  } finally {
    cleanup(ws);
  }
});

test('migrate-cycle-1a: missing inbox is no-op', () => {
  const ws = makeWorkspace(null);
  try {
    const result = migrateCycle1a(ws);
    assert.equal(result.inbox.reason, 'no-inbox');
  } finally {
    cleanup(ws);
  }
});

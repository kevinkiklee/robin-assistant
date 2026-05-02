import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../migrations/0015-create-predictions.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0015-'));
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  return dir;
}

test('migration metadata is correct', () => {
  assert.equal(id, '0015-create-predictions');
  assert.match(description, /predictions/i);
});

test('creates predictions.md from scaffold when file is missing', async () => {
  const ws = workspace();
  const target = join(ws, 'user-data/memory/self-improvement/predictions.md');
  assert.ok(!existsSync(target), 'precondition: file must not exist');

  await up({ workspaceDir: ws });

  assert.ok(existsSync(target), 'predictions.md should exist after migration');
  const content = readFileSync(target, 'utf8');
  assert.match(content, /^---/m, 'should have frontmatter');
  assert.match(content, /# Predictions/, 'should have main heading');
  assert.match(content, /## Open/, 'should have ## Open section');
  assert.match(content, /## Resolved/, 'should have ## Resolved section');
  assert.match(content, /description:.*predictions/i, 'should have description in frontmatter');
});

test('idempotent: no-op when file already exists with content', async () => {
  const ws = workspace();
  const target = join(ws, 'user-data/memory/self-improvement/predictions.md');
  const existing = `---
description: Predictions Robin made + outcomes — source of truth for calibration rollup
type: topic
---

# Predictions

## Open

### 2026-04-30 — User will buy Sigma 35 within 60 days
- check-by: 2026-06-29
- confidence: likely
- reasoning: 3 weeks of macro research

## Resolved
`;
  writeFileSync(target, existing);

  await up({ workspaceDir: ws });

  const after = readFileSync(target, 'utf8');
  assert.equal(after, existing, 'file should be unchanged when it already exists');
});

test('idempotent: re-running on migrated state is a no-op', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });
  const afterFirst = readFileSync(
    join(ws, 'user-data/memory/self-improvement/predictions.md'),
    'utf8',
  );
  await up({ workspaceDir: ws });
  const afterSecond = readFileSync(
    join(ws, 'user-data/memory/self-improvement/predictions.md'),
    'utf8',
  );
  assert.equal(afterSecond, afterFirst, 'second run must be a no-op');
});

test('preserves existing content when user has manually written predictions', async () => {
  const ws = workspace();
  const target = join(ws, 'user-data/memory/self-improvement/predictions.md');
  const userContent = `---
description: My custom predictions file
type: topic
---

# Predictions

## Open

### 2026-01-01 — Will finish the novel
- check-by: 2026-12-31
- confidence: guess
- reasoning: aspirational

## Resolved
`;
  writeFileSync(target, userContent);

  await up({ workspaceDir: ws });

  const after = readFileSync(target, 'utf8');
  assert.equal(after, userContent, 'user-authored content must not be overwritten');
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recallTopicsResolvableInvariant } from './recall-topics-resolvable.ts';

function makeUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-topics-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'content', 'knowledge'), { recursive: true });
  return dir;
}

test('recallTopicsResolvableInvariant: ok when no topics file exists', async () => {
  const ud = makeUserData();
  const inv = recallTopicsResolvableInvariant({ userData: ud });
  assert.equal(inv.name, 'recall.topics_resolvable');
  assert.equal(inv.severity, 'warning');
  const r = await inv.check();
  assert.equal(r.ok, true);
});

test('recallTopicsResolvableInvariant: ok when every mapped doc resolves', async () => {
  const ud = makeUserData();
  writeFileSync(join(ud, 'content/knowledge/a.md'), 'a');
  writeFileSync(
    join(ud, 'config/recall-topics.yaml'),
    'topics:\n  - id: t\n    match: [foo]\n    docs: [content/knowledge/a.md]\n',
  );
  const r = await recallTopicsResolvableInvariant({ userData: ud }).check();
  assert.equal(r.ok, true);
});

test('recallTopicsResolvableInvariant: flags a missing doc path', async () => {
  const ud = makeUserData();
  writeFileSync(
    join(ud, 'config/recall-topics.yaml'),
    'topics:\n  - id: t\n    match: [foo]\n    docs: [content/knowledge/missing.md]\n',
  );
  const r = await recallTopicsResolvableInvariant({ userData: ud }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /missing\.md/);
});

test('recallTopicsResolvableInvariant: flags an oversized mapped doc', async () => {
  const ud = makeUserData();
  writeFileSync(join(ud, 'content/knowledge/big.md'), 'B'.repeat(17000));
  writeFileSync(
    join(ud, 'config/recall-topics.yaml'),
    'topics:\n  - id: t\n    match: [foo]\n    docs: [content/knowledge/big.md]\n',
  );
  const r = await recallTopicsResolvableInvariant({ userData: ud }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /oversized/);
  assert.match(r.message ?? '', /big\.md/);
});

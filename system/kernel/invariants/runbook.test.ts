import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRunbook, emitRunbookSection } from './runbook.ts';
import type { Invariant } from './types.ts';

const inv: Invariant = {
  name: 'db.reachable',
  severity: 'critical',
  symptom: 'Recall fails',
  cause: 'DB closed',
  fix: 'restart',
  check: () => ({ ok: true }),
};

test('runbook: emit produces structured markdown with symptom/cause/fix', () => {
  const md = emitRunbookSection([inv]);
  assert.match(md, /db\.reachable/);
  assert.match(md, /Recall fails/);
  assert.match(md, /DB closed/);
  assert.match(md, /restart/);
});

test('runbook: writes new RUNBOOK.md if absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rb-'));
  const path = join(dir, 'RUNBOOK.md');
  const r = writeRunbook(path, [inv]);
  assert.equal(r.existed, false);
  assert.ok(existsSync(path));
  const body = readFileSync(path, 'utf8');
  assert.match(body, /db\.reachable/);
});

test('runbook: replaces between sentinels if already present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rb-'));
  const path = join(dir, 'RUNBOOK.md');
  writeFileSync(path, `# Robin Runbook\n\nOLD CONTENT\n\n<!-- robin:runbook:begin -->\n\nstale auto-gen\n\n<!-- robin:runbook:end -->\n\nFOOTER\n`);
  writeRunbook(path, [inv]);
  const body = readFileSync(path, 'utf8');
  assert.match(body, /OLD CONTENT/);
  assert.match(body, /FOOTER/);
  assert.doesNotMatch(body, /stale auto-gen/);
  assert.match(body, /db\.reachable/);
});

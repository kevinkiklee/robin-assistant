import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMissingAliases, findTypeMismatches, findStaleRelated } from '../../../scripts/memory/lint.js';

function tempWs() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-test-'));
  mkdirSync(join(dir, 'user-data', 'memory', 'profile', 'people'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'knowledge', 'medical'), { recursive: true });
  mkdirSync(join(dir, 'user-data', 'memory', 'knowledge', 'service-providers'), { recursive: true });
  return dir;
}

test('findMissingAliases fires on entity-shaped dir without aliases', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/profile/people/no-aliases.md'),
      `---\ntype: topic\n---\n# Some Person\n`);
    writeFileSync(join(ws, 'user-data/memory/profile/people/has-aliases.md'),
      `---\ntype: entity\naliases: [Jane]\n---\n# Jane\n`);
    const findings = findMissingAliases(ws);
    assert.deepEqual(findings.map(f => f.file), ['profile/people/no-aliases.md']);
    assert.equal(findings[0].check, 'missing-aliases');
    assert.equal(findings[0].severity, 'warn');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findMissingAliases fires on type:entity outside entity-shaped dir', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/knowledge/medical/some-page.md'),
      `---\ntype: entity\n---\n# X\n`);
    const findings = findMissingAliases(ws);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, 'knowledge/medical/some-page.md');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findMissingAliases does NOT fire on non-entity files', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/knowledge/medical/back-spine.md'),
      `---\ntype: topic\n---\n# Back\n`);
    const findings = findMissingAliases(ws);
    assert.equal(findings.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findMissingAliases handles quoted aliases array correctly', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/profile/people/jake.md'),
      `---\ntype: entity\naliases: ["Jake", "Joony"]\n---\n# Jake\n`);
    const findings = findMissingAliases(ws);
    assert.equal(findings.length, 0, 'quoted aliases should be recognized');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findTypeMismatches fires on entity-shaped dir + aliases + type:topic', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/profile/people/jake-lee.md'),
      `---\ntype: topic\naliases: [Jake]\n---\n# Jake Lee\n`);
    const findings = findTypeMismatches(ws);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'type-mismatch');
    assert.equal(findings[0].file, 'profile/people/jake-lee.md');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findTypeMismatches does NOT fire when type is already entity', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/profile/people/x.md'),
      `---\ntype: entity\naliases: [X]\n---\n`);
    const findings = findTypeMismatches(ws);
    assert.equal(findings.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findTypeMismatches does NOT fire outside entity-shaped dir', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/knowledge/medical/some-page.md'),
      `---\ntype: topic\naliases: [foo]\n---\n`);
    const findings = findTypeMismatches(ws);
    assert.equal(findings.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findStaleRelated fires on missing target', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/x.md'),
      `---\nrelated: [does-not-exist.md]\n---\n# X\n`);
    const findings = findStaleRelated(ws);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'stale-related');
    assert.match(findings[0].message, /does-not-exist\.md/);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findStaleRelated does NOT fire on archive/ targets', () => {
  const ws = tempWs();
  try {
    mkdirSync(join(ws, 'user-data/memory/archive'), { recursive: true });
    writeFileSync(join(ws, 'user-data/memory/x.md'),
      `---\nrelated: [archive/old-page.md]\n---\n# X\n`);
    const findings = findStaleRelated(ws);
    assert.equal(findings.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('findStaleRelated does NOT fire on existing targets', () => {
  const ws = tempWs();
  try {
    writeFileSync(join(ws, 'user-data/memory/x.md'),
      `---\nrelated: [y.md]\n---\n# X\n`);
    writeFileSync(join(ws, 'user-data/memory/y.md'), `# Y\n`);
    const findings = findStaleRelated(ws);
    assert.equal(findings.length, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

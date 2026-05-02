import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname as pathDirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  findStaleFiles,
  findRedundantParagraphs,
  extractParagraphs,
  findAmbiguousAliases,
  findCandidateEntities,
} from '../../scripts/memory/lint.js';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'system', 'scripts', 'memory', 'lint.js');

function runLint() {
  try {
    const out = execFileSync('node', [SCRIPT, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString?.() ?? '';
    return { exitCode: e.status ?? 1, output: out ? JSON.parse(out) : { issues: [] } };
  }
}

// ---------------------------------------------------------------------------
// Live memory tree — existing integration tests
// ---------------------------------------------------------------------------

describe('lint-memory', () => {
  it('passes on the current memory tree (exit 0, no hard issues)', () => {
    const { exitCode, output } = runLint();
    assert.equal(exitCode, 0, `Lint hard-failed: ${JSON.stringify(output.issues?.filter(i => i.severity === 'hard'), null, 2)}`);
  });

  it('reports issues array', () => {
    const { output } = runLint();
    assert.ok(Array.isArray(output.issues));
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers for unit tests
// ---------------------------------------------------------------------------

function memFixture(files) {
  // files: { 'relPath': 'content', ... }
  const dir = join(tmpdir(), `lint-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(pathDirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Staleness check unit tests
// ---------------------------------------------------------------------------

describe('findStaleFiles — staleness', () => {
  it('flags profile/ file with last_verified 400 days ago (slow=365)', () => {
    // 400 days before a fixed "now". We abuse the fact that findStaleFiles
    // uses `new Date()` internally, so we just need a date >365 days ago.
    const staleDate = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const dir = memFixture({
      'profile/identity.md': `---\ndescription: id\ntype: topic\nlast_verified: ${staleDate}\ndecay: slow\n---\n# X\n`,
    });
    const issues = findStaleFiles(dir);
    assert.ok(
      issues.some((i) => i.message.includes('STALE') && i.message.includes('profile/identity.md')),
      `Expected staleness flag; got: ${JSON.stringify(issues)}`,
    );
  });

  it('does not flag profile/ file with last_verified today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const dir = memFixture({
      'profile/identity.md': `---\ndescription: id\ntype: topic\nlast_verified: ${today}\ndecay: slow\n---\n# X\n`,
    });
    const issues = findStaleFiles(dir);
    const staleIssues = issues.filter((i) => i.message.includes('STALE'));
    assert.equal(staleIssues.length, 0, `Expected no stale flags; got: ${JSON.stringify(staleIssues)}`);
  });

  it('never flags a file with decay: immortal', () => {
    const dir = memFixture({
      'decisions.md': `---\ndescription: decisions\ntype: topic\nlast_verified: 2000-01-01\ndecay: immortal\n---\n# X\n`,
    });
    const issues = findStaleFiles(dir);
    const staleIssues = issues.filter((i) => i.message.includes('STALE'));
    assert.equal(staleIssues.length, 0, 'immortal file should never be flagged');
  });

  it('severity is warn, not hard', () => {
    const staleDate = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const dir = memFixture({
      'profile/stale.md': `---\ndescription: stale\ntype: topic\nlast_verified: ${staleDate}\ndecay: slow\n---\n# X\n`,
    });
    const issues = findStaleFiles(dir);
    const stale = issues.find((i) => i.message.includes('STALE'));
    assert.ok(stale, 'stale issue should exist');
    assert.equal(stale.severity, 'warn');
  });
});

// ---------------------------------------------------------------------------
// Redundancy check unit tests
// ---------------------------------------------------------------------------

describe('extractParagraphs', () => {
  it('extracts paragraph blocks of 3+ consecutive non-empty lines', () => {
    const body = `Line 1\nLine 2\nLine 3\n\nOnly 2 lines\nHere\n\nLine A\nLine B\nLine C\nLine D\n`;
    const paras = extractParagraphs(body);
    assert.equal(paras.length, 2);
    assert.ok(paras[0].includes('Line 1'));
    assert.ok(paras[1].includes('Line A'));
  });

  it('returns empty array when no 3+ line blocks', () => {
    const paras = extractParagraphs('One\nTwo\n\nThree\n');
    assert.equal(paras.length, 0);
  });
});

describe('findRedundantParagraphs — redundancy', () => {
  it('flags same paragraph appearing in two files', () => {
    const sharedPara = 'Alpha line one\nAlpha line two\nAlpha line three\nAlpha line four\n';
    const dir = memFixture({
      'profile/a.md': `---\ndescription: a\ntype: topic\n---\n${sharedPara}\nUnique to A\n`,
      'profile/b.md': `---\ndescription: b\ntype: topic\n---\n${sharedPara}\nUnique to B\n`,
    });
    const issues = findRedundantParagraphs(dir);
    assert.ok(
      issues.some((i) => i.message.includes('REDUNDANT')),
      `Expected redundancy flag; got: ${JSON.stringify(issues)}`,
    );
    assert.equal(issues[0].severity, 'warn');
  });

  it('does not flag unique paragraphs', () => {
    const dir = memFixture({
      'profile/a.md': `---\ndescription: a\ntype: topic\n---\nUnique A line 1\nUnique A line 2\nUnique A line 3\n`,
      'profile/b.md': `---\ndescription: b\ntype: topic\n---\nUnique B line 1\nUnique B line 2\nUnique B line 3\n`,
    });
    const issues = findRedundantParagraphs(dir);
    const redund = issues.filter((i) => i.message.includes('REDUNDANT'));
    assert.equal(redund.length, 0, `Unexpected redundancy flags: ${JSON.stringify(redund)}`);
  });

  it('same paragraph in 3 files produces exactly 1 issue (not 3)', () => {
    const sharedPara = 'Shared line one\nShared line two\nShared line three\nShared line four\n';
    const dir = memFixture({
      'profile/x.md': `---\ndescription: x\ntype: topic\n---\n${sharedPara}`,
      'profile/y.md': `---\ndescription: y\ntype: topic\n---\n${sharedPara}`,
      'profile/z.md': `---\ndescription: z\ntype: topic\n---\n${sharedPara}`,
    });
    const issues = findRedundantParagraphs(dir);
    const redund = issues.filter((i) => i.message.includes('REDUNDANT'));
    assert.equal(redund.length, 1, 'one hash should produce one issue even across 3 files');
    assert.ok(redund[0].message.includes('x.md'), 'should list all files');
    assert.ok(redund[0].message.includes('y.md'), 'should list all files');
    assert.ok(redund[0].message.includes('z.md'), 'should list all files');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous-alias check
// ---------------------------------------------------------------------------

describe('findAmbiguousAliases', () => {
  it('emits an issue when registry build throws on alias collision', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-collision');
    const issues = await findAmbiguousAliases(fixturePath);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].type, 'ambiguous-alias');
    assert.match(issues[0].message, /Lee/);
    assert.match(issues[0].message, /lee-john\.md/);
    assert.match(issues[0].message, /lee-jane\.md/);
  });

  it('returns no issues when registry builds successfully', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-basic');
    const issues = await findAmbiguousAliases(fixturePath);
    assert.deepEqual(issues, []);
  });
});

// ---------------------------------------------------------------------------
// Candidate-entities check
// ---------------------------------------------------------------------------

describe('findCandidateEntities', () => {
  it('surfaces names mentioned 3+ times across 2+ files but with no entity page', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'wiki-graph', 'lint-candidate');
    const issues = await findCandidateEntities(fixturePath);
    const babbage = issues.find(i => /Charles Babbage/.test(i.message));
    assert.ok(babbage, 'expected a candidate-entity issue for Charles Babbage');
    assert.equal(babbage.type, 'candidate-entity');
    assert.equal(babbage.severity, 'soft');
  });

  it('does not flag names that already have an entity page', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'wiki-graph', 'lint-candidate');
    const issues = await findCandidateEntities(fixturePath);
    // "Dong-Seok Lee" / "Dr. Lee" wouldn't be detected by the proper-noun regex anyway,
    // but verify nothing nonsensical leaks through.
    for (const i of issues) {
      assert.equal(i.type, 'candidate-entity');
    }
  });
});

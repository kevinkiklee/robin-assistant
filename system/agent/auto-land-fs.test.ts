import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fsWriteViolation } from './auto-land-fs.ts';

// ── Filesystem writes. A landed test runs unsandboxed the next time anyone runs the
//    suite, and landed code runs unsandboxed in the daemon — a new write must land
//    inside a fresh mkdtemp dir, or wait for review.

const TMP_FIXTURE = [
  "import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import { tmpdir } from 'node:os';",
  "import { join } from 'node:path';",
  "const dir = mkdtempSync(join(tmpdir(), 'kn-'));",
].join('\n');

test('fsWriteViolation: writes provably inside a fresh mkdtemp dir pass', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    "writeFileSync(join(dir, 'a.json'), '{}');",
    "mkdirSync(join(dir, 'sub', 'deep'), { recursive: true });",
    'rmSync(dir, { recursive: true, force: true });',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text, not a template
    'writeFileSync(`${dir}/a.json`, x);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text, not a template
    "let d2: string;\nd2 = mkdtempSync(`${tmpdir()}/kn-`);\nwriteFileSync(join(d2, 'b'), x);",
    "const sub = join(dir, 'state');\nwriteFileSync(join(sub, 'c.json'), x);",
  ]) {
    assert.equal(
      fsWriteViolation(
        f,
        () => `${TMP_FIXTURE}\n${added}\n`,
        () => TMP_FIXTURE,
      ),
      null,
      added,
    );
  }
});

test('fsWriteViolation: a new write anywhere else is held, in tests and code alike', () => {
  for (const file of ['system/kernel/x.test.ts', 'system/kernel/x.ts']) {
    for (const added of [
      "writeFileSync(join(homedir(), '.zshrc'), x);",
      "writeFileSync('githooks/pre-commit', x);",
      "appendFileSync('/Users/sam/.profile', x);",
      "writeFileSync(join(dir, '..', '..', 'x'), x);",
      'writeFileSync(join(dir, name), x);',
      "writeFileSync(join(tmpdir(), 'fixed-name'), x);",
      "mkdtempSync(join('/Users/sam', 'x-'));",
      'const p = statePath;\nwriteFileSync(p, x);',
      "let d3 = mkdtempSync(join(tmpdir(), 'a'));\nd3 = '/etc';\nwriteFileSync(join(d3, 'b'), x);",
      "await fsp.writeFile('/etc/hosts', x);",
      "symlinkSync('/Users/sam/.zshrc', join(dir, 'l'));\ncopyFileSync(src, '/Users/sam/.zshrc');",
    ]) {
      assert.match(
        fsWriteViolation(
          [file],
          () => `${TMP_FIXTURE}\n${added}\n`,
          () => TMP_FIXTURE,
        ) ?? '',
        /writes files outside a fresh temp dir/,
        `${file}: ${added}`,
      );
    }
  }
});

test('fsWriteViolation: aliased, computed and namespace-escaping writes are held', () => {
  const f = ['system/kernel/x.ts'];
  for (const added of [
    'const w = writeFileSync;\nw(p, x);',
    "fs['writeFileSync'](p, x);",
    "fs['write' + 'FileSync'](p, x);",
    'const f2 = fs;',
    'const o = { writeFileSync };',
    "const pr = fs.promises;\npr['write' + 'File'](p, x);",
  ]) {
    assert.match(
      fsWriteViolation(
        f,
        () => `import * as fs from 'node:fs';\n${added}\n`,
        () => "import * as fs from 'node:fs';\n",
      ) ?? '',
      /writes files outside a fresh temp dir/,
      added,
    );
  }
});

test('fsWriteViolation: new home-directory references are held', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    'const h = homedir();',
    'const h = userInfo().homedir;',
    'const h = process.env.HOME;',
    "const h = process.env['HOME'];",
  ]) {
    assert.match(
      fsWriteViolation(
        f,
        () => `const a = 1;\n${added}\n`,
        () => 'const a = 1;\n',
      ) ?? '',
      /home/,
      added,
    );
  }
});

test('fsWriteViolation: an unproven write already in a changed file holds; so does a rewritten one', () => {
  const f = ['system/kernel/x.ts'];
  const existing = 'writeFileSync(statePath, body);\n';
  assert.match(
    fsWriteViolation(
      f,
      () => `${existing}const n = 2;\n`,
      () => existing,
    ) ?? '',
    /writeFileSync\(statePath\)/,
    'a state-writing module goes to review whatever else changed',
  );
  assert.match(
    fsWriteViolation(
      f,
      () => "writeFileSync(join(cfgDir, 'x'), body);\n",
      () => existing,
    ) ?? '',
    /cfgDir/,
    'same count, different target',
  );
  // Defining a method or mock named like an fs call isn't a write.
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.test.ts'],
      () => 'const fake = { writeFile: async () => {}, mkdir() {} };\n',
      () => '',
    ),
    null,
  );
});

test('fsWriteViolation: temp-dir factories (arrow or function) count as fresh temp dirs', () => {
  const f = ['system/kernel/x.test.ts'];
  for (const added of [
    "const mk = () => mkdtempSync(join(tmpdir(), 'b-'));\nconst d = mk();\nwriteFileSync(join(d, 'a.json'), x);",
    "function makeTemp(): string {\n  const t = mkdtempSync(join(tmpdir(), 'c-'));\n  mkdirSync(join(t, 'sub'));\n  return t;\n}\nwriteFileSync(join(makeTemp(), 'b'), x);",
  ]) {
    assert.equal(
      fsWriteViolation(
        f,
        () => `${TMP_FIXTURE}\n${added}\n`,
        () => TMP_FIXTURE,
      ),
      null,
      added,
    );
  }
  // A factory with any return outside a temp dir is no factory.
  assert.match(
    fsWriteViolation(
      f,
      () =>
        `${TMP_FIXTURE}\nfunction pick(a: boolean) {\n  if (a) return '/etc';\n  return mkdtempSync(join(tmpdir(), 'd-'));\n}\nwriteFileSync(join(pick(true), 'b'), x);\n`,
      () => TMP_FIXTURE,
    ) ?? '',
    /writes files outside a fresh temp dir/,
  );
});

test("fsWriteViolation: fields and locals named like fs calls (open, rm, link) aren't writes", () => {
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.ts'],
      () =>
        'const open = alerts.filter((a) => a.open);\nif (row.open) db.open();\nconst n = open.length;\nsession.rm(id);\n',
      () => '',
    ),
    null,
  );
  // …unless they really are fs: a named import, or a call on an fs namespace.
  for (const src of [
    "import { rm } from 'node:fs/promises';\nawait rm(target, { recursive: true });\n",
    "import * as fs from 'node:fs';\nfs.rm(target, () => {});\n",
    "import * as fs from 'node:fs';\nawait fs.promises.open(target, 'w');\n",
  ]) {
    assert.match(
      fsWriteViolation(
        ['system/kernel/x.ts'],
        () => src,
        () => '',
      ) ?? '',
      /writes files outside a fresh temp dir/,
      src,
    );
  }
});

test('fsWriteViolation: fails closed — any unproven write in a changed file holds, even an unchanged call', () => {
  const f = ['system/kernel/x.ts'];
  // The call text is identical; only what `statePath` is bound to changed.
  assert.match(
    fsWriteViolation(
      f,
      () => "const statePath = '/Users/sam/.zshrc';\nwriteFileSync(statePath, body);\n",
      () => "const statePath = join(dataDir, 'state.json');\nwriteFileSync(statePath, body);\n",
    ) ?? '',
    /writes files outside a fresh temp dir: system\/kernel\/x\.ts: writeFileSync\(statePath\)/,
  );
  // A new caller of a writer defined in the same file.
  assert.match(
    fsWriteViolation(
      f,
      () =>
        "function save(p: string) {\n  writeFileSync(p, body);\n}\nsave('githooks/pre-commit');\n",
      () => 'function save(p: string) {\n  writeFileSync(p, body);\n}\n',
    ) ?? '',
    /writes files outside a fresh temp dir/,
  );
  // Writes provably inside a temp dir still pass.
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.test.ts'],
      () => `${TMP_FIXTURE}\nwriteFileSync(join(dir, 'a.json'), x);\n`,
      () => TMP_FIXTURE,
    ),
    null,
  );
});

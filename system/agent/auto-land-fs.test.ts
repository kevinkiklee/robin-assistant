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

// ── Hardening (security review, 2026-10-31): the hold is an allowlist of read-only
//    fs members, fs reached any other way is unverified, path builders count only
//    when bound to the real node:path/node:os/node:fs, and new sensitive path
//    literals hold (a write through an unchanged helper isn't followed).

const held = (src: string, head = '', files = ['system/kernel/x.ts']) =>
  fsWriteViolation(
    files,
    () => src,
    () => head,
  );

test('fsWriteViolation: any fs member off the read-only allowlist is a write (allowlist, not deny-list)', () => {
  const missed = [
    "import * as fs from 'node:fs';\nconst s = new fs.WriteStream(p);\n",
    "import { WriteStream } from 'node:fs';\nconst s = new WriteStream(p);\n",
    "import { Utf8Stream } from 'node:fs';\nconst s = new Utf8Stream({ dest: p });\n",
    "import { mkdtempDisposableSync } from 'node:fs';\nconst d = mkdtempDisposableSync('/Users/sam/x-');\n",
    "import { writev } from 'node:fs';\nwritev(fd, bufs, () => {});\n",
    "import { lchmodSync } from 'node:fs';\nlchmodSync(p, 0o777);\n",
    "import * as fs from 'node:fs';\nfs.writeSync(fd, body);\n",
    "import * as fs from 'node:fs';\nfs.someFutureWriter(p);\n",
    "import * as fsp from 'node:fs/promises';\nconst h = fsp.someFutureWriter;\n",
    // A "read" that opens for writing truncates or creates its target.
    "import { readFileSync } from 'node:fs';\nreadFileSync(p, { flag: 'w' });\n",
    "import { readFileSync } from 'node:fs';\nreadFileSync(p, opts);\n",
    "import { createReadStream } from 'node:fs';\ncreateReadStream(p, { flags: 'w+' });\n",
    "import { readFileSync } from 'node:fs';\nconst r = readFileSync;\nr(p, { flag: 'w' });\n",
  ].filter((src) => !/writes files outside a fresh temp dir/.test(held(src) ?? ''));
  assert.deepEqual(missed, []);
});

test('fsWriteViolation: read-only fs use and erased fs types pass', () => {
  const wrongly = [
    "import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';\nconst a = readFileSync(p, 'utf8');\nconst b = readFileSync(p, { encoding: 'utf8' });\nif (existsSync(p) && statSync(p).isFile()) readdirSync(d, { withFileTypes: true });\n",
    "import * as fs from 'node:fs';\nconst ok = fs.existsSync(p) && fs.constants.R_OK > 0;\nfs.readFile(p, (err, data) => {});\n",
    "import { readFile } from 'node:fs/promises';\nconst t = await readFile(p, 'utf8');\n",
    "import type { Stats } from 'node:fs';\nlet s: Stats | null = null;\n",
    "import * as fs from 'node:fs';\nlet s: fs.Stats | null = null;\nconst f: typeof fs.writeFileSync | null = null;\n",
  ].filter((src) => held(src) !== null);
  assert.deepEqual(wrongly, []);
});

test('fsWriteViolation: fs reached by require, createRequire, dynamic import or getBuiltinModule is unverified', () => {
  const missed = [
    "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nreq('node:fs').rm(p, () => {});\n",
    "import * as mod from 'module';\nconst x = mod;\n",
    "const fs = require('fs');\nfs.rm(p, () => {});\n",
    "const r = process.mainModule.require('fs');\nr.rm(p, () => {});\n",
    "const fs = await import('node:fs');\nfs.rm(p, () => {});\n",
    "const m = 'node:fs';\n(await import(m)).rm(p, () => {});\n",
    "const fs = process.getBuiltinModule('node:fs');\nfs.rm(p, () => {});\n",
    "export * from 'node:fs';\n",
    "export { rm } from 'node:fs/promises';\n",
    "export * as fs from 'fs';\n",
  ].filter((src) => !/writes files outside a fresh temp dir/.test(held(src) ?? ''));
  assert.deepEqual(missed, []);
});

test('fsWriteViolation: importing from a local module that re-exports fs is unverified', () => {
  const sources: Record<string, string> = {
    'system/kernel/fsx.ts': "export * from 'node:fs/promises';\n",
    'system/kernel/hop.ts': "export { rm as tidy } from './fsx.ts';\n",
    'system/kernel/plain.ts': 'export const n = 1;\n',
  };
  const read = (f: string) => sources[f] ?? null;
  const missed = [
    "import { rm } from './fsx.ts';\nawait rm(p);\n",
    "import * as f from './fsx.js';\nawait f.rm(p);\n",
    "import { tidy } from './hop.ts';\nawait tidy(p);\n",
    "const f = await import('./fsx.ts');\nawait f.rm(p);\n",
  ].filter((src) => {
    const v = fsWriteViolation(
      ['system/kernel/x.test.ts'],
      (f) => (f === 'system/kernel/x.test.ts' ? src : read(f)),
      () => null,
    );
    return !/writes files outside a fresh temp dir: system\/kernel\/x\.test\.ts/.test(v ?? '');
  });
  assert.deepEqual(missed, []);
  assert.equal(
    fsWriteViolation(
      ['system/kernel/x.test.ts'],
      (f) => (f === 'system/kernel/x.test.ts' ? "import { n } from './plain.ts';\n" : read(f)),
      () => null,
    ),
    null,
  );
});

test('fsWriteViolation: join/resolve/tmpdir/mkdtemp are trusted only when bound to node:path/os/fs', () => {
  const writes = "writeFileSync(join(dir, 'a.json'), x);\n";
  const missed = [
    // A local join that ignores its arguments.
    `${TMP_FIXTURE.replace("import { join } from 'node:path';", "const join = (..._a: string[]) => '/Users/sam/.zshrc';")}\n${writes}`,
    // join imported from somewhere else.
    `${TMP_FIXTURE.replace("from 'node:path'", "from './paths.ts'")}\n${writes}`,
    // join re-bound after the real import.
    `${TMP_FIXTURE}\nfunction g(join: (...a: string[]) => string) {\n  writeFileSync(join(dir, 'a'), x);\n}\n`,
    // tmpdir / join / mkdtempSync by spelling on some other receiver.
    "import { mkdtempSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst evil = { tmpdir: () => '/Users/sam' };\nconst d = mkdtempSync(join(evil.tmpdir(), 'x-'));\nwriteFileSync(join(d, 'a'), x);\n",
    `${TMP_FIXTURE}\nconst evil = { join: (..._a: string[]) => '/Users/sam/.zshrc' };\nwriteFileSync(evil.join(dir, 'a'), x);\n`,
    "import { writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst mkdtempSync = (_p: string) => '/Users/sam/.ssh';\nconst d = mkdtempSync(join(tmpdir(), 'x-'));\nwriteFileSync(join(d, 'k'), x);\n",
  ].filter((src) => !/writes files outside/.test(held(src, '', ['system/kernel/x.test.ts']) ?? ''));
  assert.deepEqual(missed, []);
  // Namespace and aliased imports of the real modules still prove a temp dir.
  const wrongly = [
    "import * as fs from 'node:fs';\nimport * as os from 'node:os';\nimport * as path from 'node:path';\nconst d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.writeFileSync(path.join(d, 'a'), x);\n",
    "import { mkdtempSync as mk, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'os';\nimport { resolve } from 'path';\nconst d = mk(resolve(tmpdir(), 'x-'));\nwriteFileSync(resolve(d, 'a'), x);\n",
    "import { mkdtemp, writeFile } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst d = await mkdtemp(join(tmpdir(), 'x-'));\nawait writeFile(join(d, 'a'), x);\n",
  ].filter((src) => held(src, '', ['system/kernel/x.test.ts']) !== null);
  assert.deepEqual(wrongly, []);
});

test('fsWriteViolation: new sensitive path literals hold — a write through an unchanged helper', () => {
  const head = "import { saveJson } from './store.ts';\n";
  const missed: string[] = [];
  for (const lit of [
    "'/Users/sam/Library/LaunchAgents/x.plist'",
    "'/tmp/fixed'",
    "'~/.zshrc'",
    "'$HOME/.bashrc'",
    "'githooks/pre-commit'",
    "'.git/hooks/post-merge'",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text, not a template
    '`${base}/.ssh/config`',
    "join(dir, '..', 'Library', 'x')",
  ]) {
    for (const file of ['system/kernel/x.ts', 'system/kernel/x.test.ts']) {
      if (!/sensitive path/.test(held(`${head}saveJson(${lit}, body);\n`, head, [file]) ?? '')) {
        missed.push(`${file}: ${lit}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  // Present at HEAD already (same multiset) → not new; ordinary literals pass.
  const kept = "const bin = '/usr/sbin/sysctl';\n";
  assert.equal(held(`${kept}const n = 2;\n`, kept), null);
  assert.match(held(`${kept}${kept}`, kept) ?? '', /sensitive path/, 'a second copy is new');
  assert.equal(
    held("const a = 'state.json';\nconst s = '/';\nconst u = p.split('/');\nconst r = 'kn-';\n"),
    null,
  );
});

test('fsWriteViolation: a shadowed fs namespace proves no temp dir, and its writes still hold', () => {
  const imports =
    "import * as fs from 'node:fs';\nimport * as fsp from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n";
  const shadowed: Array<[string, RegExp]> = [
    // `fs` re-bound by a parameter: its mkdtempSync is whatever the caller passes,
    // so the dir it returns proves nothing and the write into it is unproven.
    [
      `${imports}function f(fs: { mkdtempSync: (a: string) => string; writeFileSync: (a: string, b: string) => void }) {\n  const d = fs.mkdtempSync(join(tmpdir(), 'x-'));\n  fs.writeFileSync(join(d, 'a'), x);\n}\n`,
      /ref:fs\b.*writeFileSync\(join\(d, "a"\)\)/,
    ],
    [
      `${imports}function g(fsp: { mkdtemp: (a: string) => Promise<string> }) {\n  return fsp.mkdtemp(join(tmpdir(), 'x-'));\n}\nconst d = await g(evil);\nawait fs.promises.writeFile(join(d, 'a'), x);\n`,
      /ref:fsp\b.*writeFile\(join\(d, "a"\)\)/,
    ],
    // Still fs for detection (fail closed).
    [
      `${imports}function h(fs: { rm: (a: string) => void }) {\n  fs.rm(p);\n}\n`,
      /ref:fs;.*rm\(p\)/,
    ],
  ];
  const missed = shadowed
    .filter(([src, re]) => !re.test(held(src, '', ['system/kernel/x.test.ts']) ?? ''))
    .map(([src]) => src);
  assert.deepEqual(missed, []);
  // Unshadowed, the same namespaces prove a temp dir.
  assert.equal(
    held(
      `${imports}const d = fs.mkdtempSync(join(tmpdir(), 'x-'));\nfs.writeFileSync(join(d, 'a'), x);\nconst e = await fsp.mkdtemp(join(tmpdir(), 'y-'));\nawait fs.promises.writeFile(join(e, 'b'), x);\n`,
      '',
      ['system/kernel/x.test.ts'],
    ),
    null,
  );
});

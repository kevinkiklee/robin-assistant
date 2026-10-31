// Spec §3.4 layer 4 fast-fail: lab code must not import the daemon, servers, scheduler
// or the paid agent provider, and must never load the live secrets file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const LAB = import.meta.dirname;
const DENY = [
  'surfaces/mcp',
  'surfaces/http',
  'kernel/scheduler',
  'cognition-runner-entry',
  'claude-agent',
];
// `from '...'`, `import '...'` side-effect form, and dynamic `import('...')`.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]+)\1/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'fixtures' || name === 'runs' || name === 'node_modules') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('lab code: no denied imports, no loadEnvFile', () => {
  const files = walk(LAB);
  assert.ok(files.length > 10, 'expected to scan the lab tree');
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(LAB, f);
    for (const m of src.matchAll(SPEC)) {
      const hit = DENY.find((d) => m[2].includes(d));
      if (hit) offenders.push(`${rel}: imports ${m[2]}`);
    }
    if (src.includes('loadEnvFile')) offenders.push(`${rel}: mentions loadEnvFile`);
  }
  assert.deepEqual(offenders, []);
});

test('lint pattern catches the shapes it claims to', () => {
  const sample = [
    "import x from '../system/surfaces/mcp/core/server.ts';",
    "const m = await import('../system/kernel/scheduler/x.ts');",
    "import '../system/claude-agent/y.ts';",
  ].join('\n');
  const specs = [...sample.matchAll(SPEC)].map((m) => m[2]);
  assert.equal(specs.filter((s) => DENY.some((d) => s.includes(d))).length, 3);
  // a provider-name string that is not an import specifier is not flagged
  assert.equal([...`const allow = ['claude-agent'];`.matchAll(SPEC)].length, 0);
});

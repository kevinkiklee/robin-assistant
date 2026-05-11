// Audit grep: production source must not reference any of the old (pre-redesign)
// table names or per-relation edge tables outside the documented exceptions.
//
// Spec §15 task 7.1. Exceptions:
// - Comment lines (containing the table name in a comment)
// - 0001-init.surql itself, which contains the rename comments
//
// Performance: one `git grep` invocation with all patterns instead of 21
// separate spawns. Each child_process is ~150ms on macOS; batching pulled
// this test from ~3.9s to ~50ms.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

const FORBIDDEN = [
  // Old per-kind memo tables
  { token: 'FROM knowledge', desc: 'old knowledge table' },
  { token: 'CREATE knowledge ', desc: 'old knowledge table' },
  { token: 'UPSERT knowledge', desc: 'old knowledge table' },
  { token: 'FROM patterns', desc: 'old patterns table' },
  { token: 'CREATE patterns ', desc: 'old patterns table' },
  { token: 'UPSERT patterns', desc: 'old patterns table' },
  { token: 'FROM threads', desc: 'old threads table' },
  { token: 'CREATE threads ', desc: 'old threads table' },
  { token: 'UPSERT threads', desc: 'old threads table' },
  { token: 'FROM predictions', desc: 'old predictions table' },
  { token: 'CREATE predictions ', desc: 'old predictions table' },
  // Old per-relation edge tables (as tables — NOT as edge kind strings)
  { token: 'FROM mentions', desc: 'old mentions edge table' },
  { token: 'FROM about ', desc: 'old about edge table' },
  { token: 'FROM precedes', desc: 'old precedes edge table' },
  { token: 'FROM works_on', desc: 'old works_on edge table' },
  { token: 'FROM participates_in', desc: 'old participates_in edge table' },
  { token: 'FROM co_occurs_with', desc: 'old co_occurs_with edge table' },
  // RELATE syntax — all writes should go through store.relate now
  { token: 'RELATE ', desc: 'RELATE syntax (use store.relate)' },
  // Old singletons / log tables
  { token: 'profile:singleton', desc: 'renamed to persona:singleton' },
  { token: 'recall_events', desc: 'renamed to recall_log' },
  { token: 'runtime_intuition_telemetry', desc: 'renamed to intuition_telemetry' },
];

const ALLOWED_PATHS = [
  /^src\/schema\/migrations\/0001-init\.surql$/, // comments + rename notes
];

function isAllowed(path, text) {
  if (ALLOWED_PATHS.some((rx) => rx.test(path))) return true;
  const trimmed = text.trimStart();
  // SurrealQL comment, JS line/block comment.
  if (trimmed.startsWith('--') || trimmed.startsWith('//') || trimmed.startsWith('*')) return true;
  // Test files describing the audit itself.
  if (path === 'tests/unit/audit-no-old-tables.test.js') return true;
  return false;
}

// One spawn for all tokens. `git grep -e A -e B ...` reports the matching line
// once even if it matches multiple patterns; we re-attribute matches to tokens
// locally with a simple substring scan.
function gitGrepAll(tokens) {
  const args = ['grep', '-nI', '--no-color', '--fixed-strings'];
  for (const t of tokens) args.push('-e', t);
  args.push('--', 'src/');
  let out = '';
  try {
    out = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // exit 1 = no matches; expected for clean source.
    return [];
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (m) rows.push({ path: m[1], lineNo: m[2], text: m[3] });
  }
  return rows;
}

const allMatches = gitGrepAll(FORBIDDEN.map((f) => f.token));

describe('audit: no old table or singleton names in production source', () => {
  for (const { token, desc } of FORBIDDEN) {
    it(`no reference to "${token}" (${desc})`, () => {
      const violations = allMatches.filter(
        (m) => m.text.includes(token) && !isAllowed(m.path, m.text),
      );
      assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} disallowed reference(s) to "${token}":\n${violations.map((v) => `  ${v.path}:${v.lineNo}  ${v.text.trim()}`).join('\n')}`,
      );
    });
  }
});

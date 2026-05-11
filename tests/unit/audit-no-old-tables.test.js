// Audit grep: production source must not reference any of the old (pre-redesign)
// table names or per-relation edge tables outside the documented exceptions.
//
// Spec §15 task 7.1. Exceptions:
// - src/migrate-v1/* — explicitly stale; targets v1 schema
// - src/db/browse/* — marked stale; deferred UI rewrite
// - Comment lines (containing the table name in a comment)
// - 0001-init.surql itself, which contains the rename comments

import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

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
  /^src\/migrate-v1\//,
  /^src\/db\/browse\//,
  /^src\/schema\/migrations\/0001-init\.surql$/, // comments + rename notes
];

function gitGrep(token) {
  // Hard-fail-tolerant: empty grep returns exit 1; capture both.
  try {
    const out = execFileSync(
      'git',
      ['grep', '-nI', '--no-color', '--fixed-strings', token, '--', 'src/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^([^:]+):(\d+):(.*)$/);
        return m ? { path: m[1], lineNo: m[2], text: m[3] } : null;
      })
      .filter(Boolean);
  } catch {
    // exit 1 = no matches; expected for clean source.
    return [];
  }
}

function isAllowed(path, text) {
  if (ALLOWED_PATHS.some((rx) => rx.test(path))) return true;
  const trimmed = text.trimStart();
  // SurrealQL comment, JS line/block comment.
  if (trimmed.startsWith('--') || trimmed.startsWith('//') || trimmed.startsWith('*')) return true;
  // Test files describing the audit itself.
  if (path === 'tests/unit/audit-no-old-tables.test.js') return true;
  return false;
}

describe('audit: no old table or singleton names in production source', () => {
  for (const { token, desc } of FORBIDDEN) {
    it(`no reference to "${token}" (${desc})`, () => {
      const matches = gitGrep(token);
      const violations = matches.filter((m) => !isAllowed(m.path, m.text));
      assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} disallowed reference(s) to "${token}":\n` +
          violations.map((v) => `  ${v.path}:${v.lineNo}  ${v.text.trim()}`).join('\n'),
      );
    });
  }
});

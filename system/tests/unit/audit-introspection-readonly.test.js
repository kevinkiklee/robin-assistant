// Theme 4 invariant: introspection tools never write to the DB. Catches a
// regression where an explain_* / show_* tool accidentally runs CREATE /
// UPDATE / DELETE / UPSERT / INSERT.
//
// Scope is intentionally narrow: only the seven introspection tools defined
// for Theme 4. Other MCP tools may legitimately write.
//
// Cognition D3 extension: `belief.js` is read-only in practice but writes
// advisory rows to `cadence_telemetry` for the C3 hot-bridge rollup. The
// PER_FILE_WRITE_ALLOWLIST permits this one table — any other CREATE/UPDATE
// inside belief.js still fails the audit.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const INTROSPECTION_TOOLS = [
  'system/io/mcp/tools/explain-recall.js',
  'system/io/mcp/tools/explain-belief.js',
  'system/io/mcp/tools/explain-action-trust.js',
  'system/io/mcp/tools/show-pending-triggers.js',
  'system/io/mcp/tools/show-step-health.js',
  'system/io/mcp/tools/show-telemetry-rollup.js',
  'system/io/mcp/tools/recent-refusals.js',
  'system/io/mcp/tools/archive-history.js',
  'system/io/mcp/tools/belief.js',
];

// These are full SurrealQL statement keywords. We require them to appear
// followed by a space so we don't trip on identifiers that contain the
// substring (e.g. `CREATED_AT`, function names like `update_*`).
const FORBIDDEN = ['CREATE ', 'UPDATE ', 'DELETE ', 'UPSERT ', 'INSERT ', 'RELATE '];

// Per-file targeted allow-list: introspection tools that legitimately write
// to a single advisory/telemetry table are permitted to use a write keyword
// IFF the immediately-following token is one of the allow-listed tables.
const PER_FILE_WRITE_ALLOWLIST = {
  'system/io/mcp/tools/belief.js': new Set(['cadence_telemetry']),
};

function followingTokens(src, kw) {
  const tokens = [];
  let pos = 0;
  while (true) {
    const idx = src.indexOf(kw, pos);
    if (idx < 0) break;
    const tail = src.slice(idx + kw.length);
    const m = tail.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    tokens.push(m ? m[1] : '<unknown>');
    pos = idx + kw.length;
  }
  return tokens;
}

test('introspection tools are read-only (no CREATE/UPDATE/DELETE/UPSERT/INSERT/RELATE)', () => {
  for (const path of INTROSPECTION_TOOLS) {
    if (!existsSync(path)) {
      throw new Error(`expected introspection tool file missing: ${path}`);
    }
    const src = readFileSync(path, 'utf8');
    const allow = PER_FILE_WRITE_ALLOWLIST[path];
    for (const kw of FORBIDDEN) {
      if (!src.includes(kw)) continue;
      if (!allow) {
        assert.fail(
          `${path} contains forbidden write keyword "${kw.trim()}" — introspection tools must be read-only`,
        );
      }
      // Validate every occurrence touches only allow-listed tables.
      const tokens = followingTokens(src, kw);
      for (const tok of tokens) {
        assert.ok(
          allow.has(tok),
          `${path}: forbidden "${kw.trim()}${tok}" — only [${[...allow].join(', ')}] permitted after ${kw.trim()}`,
        );
      }
    }
  }
});

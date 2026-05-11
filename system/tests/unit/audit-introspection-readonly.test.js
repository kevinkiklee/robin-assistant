// Theme 4 invariant: introspection tools never write to the DB. Catches a
// regression where an explain_* / show_* tool accidentally runs CREATE /
// UPDATE / DELETE / UPSERT / INSERT.
//
// Scope is intentionally narrow: only the seven introspection tools defined
// for Theme 4. Other MCP tools may legitimately write.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const INTROSPECTION_TOOLS = [
  'src/mcp/tools/explain-recall.js',
  'src/mcp/tools/explain-belief.js',
  'src/mcp/tools/explain-action-trust.js',
  'src/mcp/tools/show-pending-triggers.js',
  'src/mcp/tools/show-step-health.js',
  'src/mcp/tools/recent-refusals.js',
  'src/mcp/tools/archive-history.js',
];

// These are full SurrealQL statement keywords. We require them to appear
// followed by a space so we don't trip on identifiers that contain the
// substring (e.g. `CREATED_AT`, function names like `update_*`).
const FORBIDDEN = ['CREATE ', 'UPDATE ', 'DELETE ', 'UPSERT ', 'INSERT ', 'RELATE '];

test('introspection tools are read-only (no CREATE/UPDATE/DELETE/UPSERT/INSERT/RELATE)', () => {
  for (const path of INTROSPECTION_TOOLS) {
    if (!existsSync(path)) {
      throw new Error(`expected introspection tool file missing: ${path}`);
    }
    const src = readFileSync(path, 'utf8');
    for (const kw of FORBIDDEN) {
      // Search case-sensitive — SurrealQL keywords are conventionally upper.
      assert.ok(
        !src.includes(kw),
        `${path} contains forbidden write keyword "${kw.trim()}" — introspection tools must be read-only`,
      );
    }
  }
});

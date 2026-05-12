// passes/c-links.js — materialize LINKS.md as `mentions` edges.
//
// LINKS.md rows are memo→memo references in v1's view. v2's edge registry
// constrains `mentions` to `memo → entity`, so we resolve each row's `to_path`
// to the corresponding entity (created in Pass A).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RecordId } from 'surrealdb';
import { findByPath } from '../ledger.js';
import { parseLinksMd } from '../parsers/links-md.js';
import { upsertEdge } from '../writers/edge-writer.js';

function parseRecordIdStr(s) {
  if (!s || typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i < 1) return null;
  return new RecordId(s.slice(0, i), s.slice(i + 1));
}

// `sessionId` is unused: edge writes go through `upsertEdge`, which is
// idempotent via the composite (kind, in, out) record id and bypasses the
// `_v1_imports` ledger. Kept in the signature for symmetry with other passes
// in case a future change adds per-edge ledger entries.
export async function passLinks({ memoryDir, entitiesByPath, db, sessionId: _s, report }) {
  const counts = { edges: 0, unresolved: 0, errors: 0 };
  const linksPath = join(memoryDir, 'LINKS.md');
  if (!existsSync(linksPath)) return { counts };
  const body = await readFile(linksPath, 'utf8');
  const rows = parseLinksMd(body);
  for (const row of rows) {
    try {
      // Scope to kind='memo'. Profile files (interests/identity/character/
      // routines/preferences) emit both a `memo` row AND a `persona_field`
      // row; without the kind filter, the persona_field shadows the memo
      // when it was written later, so every LINK from a profile file fell
      // into the unresolved branch.
      const fromLedger = await findByPath(db, row.from_path, { kind: 'memo' });
      if (!fromLedger) {
        counts.unresolved++;
        report.warnings.unresolved_link.push(row);
        continue;
      }
      const targetEntity = entitiesByPath.get(row.to_path);
      if (!targetEntity) {
        counts.unresolved++;
        report.warnings.unresolved_link.push(row);
        continue;
      }
      const fromId = parseRecordIdStr(fromLedger.target);
      if (!fromId) {
        counts.unresolved++;
        report.warnings.unresolved_link.push(row);
        continue;
      }
      await upsertEdge(db, {
        from: fromId,
        to: targetEntity.id,
        kind: 'mentions',
        context: row.context || undefined,
      });
      counts.edges++;
    } catch (e) {
      counts.errors++;
      report.errors.push({ pass: 'C', row, message: e.message });
    }
  }
  return { counts };
}

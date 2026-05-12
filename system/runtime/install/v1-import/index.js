// index.js — orchestrates the v1 → v2 import pipeline.
//
// Public entry point for the CLI (`robin import-v1 --src ...`) and tests.
// Resolves the v1 memory dir from --src (accepts either user-data root or
// user-data/memory), generates a session ULID, runs Passes 0 through G in
// order, and returns the populated `report` object.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession, mostRecentSession, summary } from './ledger.js';
import { buildCanonicalNameTable } from './passes/0-entities-md.js';
import { passEntities } from './passes/a-entities.js';
import { passMemos } from './passes/b-memos.js';
import { passLinks } from './passes/c-links.js';
import { passEvents } from './passes/d-events.js';
import { passRulesPatterns } from './passes/e-rules-patterns.js';
import { passSources } from './passes/f-sources.js';
import { passEmbed } from './passes/g-embed.js';
import { newReport } from './report.js';

/**
 * Resolve v1 memory root from --src. Accepts either the user-data root
 * (which contains memory/) or the user-data/memory dir directly.
 *
 * @returns {{ memoryDir: string, srcRoot: string }} — `srcRoot` is one level
 *   above `memoryDir` (so `srcRoot/sources/` resolves correctly).
 */
export function resolveSrc(src) {
  if (!src) throw new TypeError('resolveSrc: --src required');
  const cand1 = join(src, 'memory');
  if (existsSync(join(cand1, 'INDEX.md'))) {
    return { memoryDir: cand1, srcRoot: src };
  }
  if (existsSync(join(src, 'INDEX.md'))) {
    return { memoryDir: src, srcRoot: join(src, '..') };
  }
  throw new Error(
    `--src does not look like a v1 user-data dir: no memory/INDEX.md or INDEX.md found at ${src}`,
  );
}

/**
 * Run the full v1 → v2 import.
 *
 * @param {object} opts
 * @param {string} opts.src           Path to v1 user-data (or user-data/memory).
 * @param {object} opts.db            SurrealDB handle (already migrated through 0023).
 * @param {string} opts.robinHome     v2 user-data root (target for sources/ copy).
 * @param {'sync'|'defer'} [opts.embed='sync']
 * @param {boolean} [opts.includeViews=false] Override the views skip list.
 * @returns {Promise<{ sessionId: string, report: object }>}
 */
export async function runImport(opts) {
  const { src, db, robinHome, embed = 'sync', includeViews = false } = opts;
  const { memoryDir, srcRoot } = resolveSrc(src);
  const sessionId = newSessionId();
  const report = newReport();
  report.embed_mode = embed;

  // Pass 0 — canonical name table (in-memory).
  const canonical = await buildCanonicalNameTable(memoryDir);

  // Pass A — entities.
  const a = await passEntities({ memoryDir, canonical, db, sessionId, report });
  report.counts.entities.created = a.counts.created;
  report.counts.entities.merged = a.counts.merged;

  // Pass B — memos + persona facets + about edges.
  const b = await passMemos({
    memoryDir,
    entitiesByPath: a.entitiesByPath,
    db,
    sessionId,
    report,
    includeViews,
  });
  report.counts.memos = b.counts.memos_created;
  report.counts.memos_skipped = b.counts.memos_skipped;
  report.counts.edges += b.counts.edges;
  report.counts.chunked = b.counts.chunked;
  report.breakdown_edges.about += b.counts.edges;

  // Pass C — LINKS.md edges.
  const c = await passLinks({ memoryDir, entitiesByPath: a.entitiesByPath, db, sessionId, report });
  report.counts.edges += c.counts.edges;
  report.breakdown_edges.mentions += c.counts.edges;

  // Pass D — events.
  const d = await passEvents({ memoryDir, db, sessionId, report });
  report.counts.events = d.counts.created;
  report.counts.events_skipped = d.counts.skipped;

  // Pass E — rules + patterns + refusals.
  const e = await passRulesPatterns({ memoryDir, db, sessionId, report });
  report.counts.rules = e.counts.rules;
  report.counts.patterns = e.counts.patterns;
  report.counts.refusals = e.counts.refusals;

  // Pass F — sources/ filesystem copy.
  const f = await passSources({ srcRoot, destRoot: robinHome, db, sessionId, report });
  report.counts.source_files = f.counts.copied;

  // Pass G — embedding backfill.
  const g = await passEmbed({ db, mode: embed, report });
  report.embed_summary = g.summary;

  report.finished_at = new Date();
  return { sessionId, report };
}

/**
 * Roll back a prior import session. Deletes target records and the ledger rows
 * themselves. Sources/ filesystem copies are left in place (user removes if
 * desired).
 */
export async function rollbackImport({ db, sessionId }) {
  let session = sessionId;
  if (!session) session = await mostRecentSession(db);
  if (!session) {
    return { rolledBack: false, reason: 'no prior session found' };
  }
  const counts = await deleteSession(db, session);
  return { rolledBack: true, sessionId: session, counts };
}

export { summary as sessionSummary };

function newSessionId() {
  return randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26);
}

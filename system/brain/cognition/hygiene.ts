import type { RobinDb } from '../memory/db.ts';

export interface HygieneResult {
  relationsDeleted: number;
  /** Duplicate (subject, predicate, object) relation copies collapsed to one row. */
  relationsDeduped: number;
  /** Tier 1 pattern matches + retroactive blocklist sweeps + Tier 2 auto-culls. */
  entitiesDeleted: number;
  /** Tier 2 score-based deletions (subset of entitiesDeleted; never blocklisted). */
  entitiesAutoCulled: number;
  blocklistGrown: number;
  orphansDeleted: number;
}

interface EntityRow {
  id: number;
  type: string;
  canonical_name: string;
  profile: string | null;
}

// ─── Tier 1: auto-delete patterns ────────────────────────────────────────────

const TIER1_NOISE_TYPES = new Set(['thing', 'topic']);

const ENV_VAR_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const CAMEL_CASE_RE = /^[a-z]+[A-Z]/;
const PASCAL_MULTI_RE = /^[A-Z][a-z]+[A-Z][a-zA-Z]+$/;
const COMMIT_PREFIX_RE = /^(?:chore|feat|fix|refactor|ci|build|docs|style|perf|test)\b/i;
const PHASE_CODENAME_RE = /^(?:Phase|Track|Stage|Sprint|Milestone)\s/i;
const DB_TABLE_REF_RE = /\b(?:table|column|index|migration|constraint|foreign key)$/i;
const IMPORT_RE = /^(?:import|require|export)\s/;
const OUTPUT_RE = /^output:\s/;
// CSS units require a leading digit (16px, 1.5rem) so they don't match real
// words ending in px/rem — e.g. the medication "Rozerem".
const CODE_SYNTAX_RE =
  /(?:=>|::|`|^\{|^\[|^\(|var\(--|\d(?:px|rem)\b|width:|height:|background:|border:)/;
const MCP_TOOL_RE = /^mcp__/;
const CLI_CMD_RE = /^(?:git|pnpm|npm|npx|yarn|node|tsx|tsc|bun|deno|python|pip|cargo|rustc)\s/;
// Robin's own internal jargon — entities named after the system's machinery are
// noise. Tokens here must be UNAMBIGUOUSLY software jargon: ambiguous English
// words (dream, brief, recall, migration, schema, route, hygiene, cognition,
// intuition, primer, cache) were removed because they delete real media/topics
// ("Requiem for a Dream", "bird migration", "Sleep hygiene"). Robin's own
// component names are caught separately by the `dev_internal` reason.
const DEV_JARGON_RE =
  /(?:^|[\s-])(?:ci|cd|lock|pid|dispatch|cron|daemon|cursor|script|hash|protocol|liveness|early-exit|launchd|scheduler|tick|heartbeat|stderr|stdout|stacktrace|traceback|queue|backlog|workflow|gitleaks|biographer|disambiguation|chunk|cursor-rule|codebase|session-id|handoff|wordmark|webhook|endpoint|middleware|refactor|regex|callback|payload|serializ|deserializ|upsert|backfill|rollback|shim|polyfill|monorepo|turbopack|bundler|transpil|lint|typecheck|monkeypatch|hotfix|bugfix|debounce|throttle|mutex|semaphore|subagent|antipattern|accessor|telemetry|worktree|wrappers|prune|singleton|crud|ingest|embedder)(?:$|[\s-])/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
// Phone-shaped: NANP 10-digit with optional grouping. The old generic
// digit-soup pattern matched year ranges ("2024 - 2026") and numeric lists.
const PHONE_RE = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/;
const MEASUREMENT_RE = /^\d+(\.\d+)?\s*(mm|cm|m|MP|mp|px|BPM|bpm|HU|hu|kg|lbs|lb|oz|°F|°C)\b/;
const DIMENSION_RE = /^\d+(\.\d+)?\s*(mm|cm|m)?\s*x\s*\d/i;
const BARE_PERCENT_RE = /^\d+(\.\d+)?%$/;
const BODY_METRIC_RE = /^recovery\s+\d/i;
const VAGUE_TEMPORAL_RE = /^~/;
const BARE_FOCAL_RE = /^\d+-?\d*mm\b/;
// Bare domain name as a `thing`/`topic` is noise — captured from browsing scans,
// no profile, no real-world referent on its own. Subdomain segment is optional
// (`*` not `+`) so single-label domains like "leadhearth.com" match too. Only
// runs on thing/topic types, so Kevin's real projects (typed project/service)
// are never touched.
const BARE_DOMAIN_RE =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|app|org|net|co|dev|ai|sh|me|xyz|so)$/i;

// ─── Cross-type noise (any entity type, not just thing/topic) ────────────────
// Robin's own machinery captured as entities from its self-referential dev
// sessions. These get mis-typed as service/tool/project, so they escape the
// thing/topic-gated Tier 1 scan entirely. Both patterns are unambiguous — no
// real-world entity Kevin cares about looks like this — so they run on all types.
const ROBIN_LAUNCHD_RE = /^io\.robin-assistant\b/i;
// Internal roadmap codenames mis-typed as `project`: "Phase 4a edge",
// "Track B Phase 1", "M0 Phase A". Real products use proper-noun names.
const PROJECT_CODENAME_RE = /^(?:Phase|Track|Stage|Sprint|Milestone)\b|^M\d+\s+Phase\b/i;

function isCrossTypeNoise(e: EntityRow): string | null {
  if (ROBIN_LAUNCHD_RE.test(e.canonical_name)) return 'robin_launchd_label';
  if (e.type.toLowerCase() === 'project' && PROJECT_CODENAME_RE.test(e.canonical_name))
    return 'project_codename';
  return null;
}

function isTier1Noise(e: EntityRow): string | null {
  const name = e.canonical_name;
  const t = e.type.toLowerCase();
  if (!TIER1_NOISE_TYPES.has(t)) return null;

  if (MCP_TOOL_RE.test(name)) return 'mcp_tool_name';
  if (COMMIT_PREFIX_RE.test(name)) return 'commit_message';
  if (PHASE_CODENAME_RE.test(name)) return 'phase_codename';
  if (ENV_VAR_RE.test(name)) return 'env_var';
  if (CAMEL_CASE_RE.test(name)) return 'camel_case';
  if (PASCAL_MULTI_RE.test(name) && !/\s/.test(name)) return 'pascal_case';
  if (IMPORT_RE.test(name)) return 'import_statement';
  if (OUTPUT_RE.test(name)) return 'code_output';
  // Require a snake_case identifier so real schema refs ("belief_candidates table",
  // "subject_id column") match but common English ("bird migration", "spinal column",
  // "glycemic index", "dinner table") is preserved.
  if (DB_TABLE_REF_RE.test(name) && name.includes('_')) return 'db_table_ref';
  if (CODE_SYNTAX_RE.test(name)) return 'code_syntax';
  if (CLI_CMD_RE.test(name)) return 'cli_command';
  if (DEV_JARGON_RE.test(name)) return 'dev_jargon';
  if (ISO_DATE_RE.test(name)) return 'iso_date';
  if (YEAR_MONTH_RE.test(name)) return 'year_month';
  if (PHONE_RE.test(name)) return 'phone_number';
  if (MEASUREMENT_RE.test(name)) return 'measurement';
  if (DIMENSION_RE.test(name)) return 'dimension';
  if (BARE_PERCENT_RE.test(name)) return 'bare_percent';
  if (BODY_METRIC_RE.test(name)) return 'body_metric';
  if (VAGUE_TEMPORAL_RE.test(name)) return 'vague_temporal';
  if (BARE_FOCAL_RE.test(name)) return 'bare_focal_length';
  if (BARE_DOMAIN_RE.test(name)) return 'bare_domain';

  const words = name.split(/\s+/);
  if (words.length >= 6) return 'sentence_length';

  return null;
}

// ─── Tier 2: borderline scoring ──────────────────────────────────────────────

const COMMON_SINGLE_WORDS = new Set([
  'state',
  'context',
  'agent',
  'check',
  'open',
  'message',
  'signal',
  'type',
  'scope',
  'status',
  'mode',
  'event',
  'action',
  'query',
  'source',
  'target',
  'level',
  'stage',
  'block',
  'entry',
  'path',
  'key',
  'link',
  'run',
  'log',
  'push',
  'pull',
  'load',
  'call',
  'flag',
  'hook',
  'rule',
  'pipe',
  'node',
  'port',
  'host',
  'view',
]);

function scoreTier2(e: EntityRow, relationCount: number): number {
  let score = 0;
  const t = e.type.toLowerCase();
  if (t === 'thing' || t === 'topic') score++;
  if (!e.profile) score++;
  if (relationCount <= 1) score++;
  const words = e.canonical_name.trim().split(/\s+/);
  if (words.length === 1 && COMMON_SINGLE_WORDS.has(words[0].toLowerCase())) score++;
  return score;
}

// ─── Blocked predicates (safety net) ─────────────────────────────────────────

const BLOCKED_PREDICATES = [
  'occurs_with',
  'related_to',
  'associated_with',
  'mentioned_with',
  'appears_with',
  'co-occurs_with',
  'co_occurs_with',
  'linked_to',
  'connected_to',
  'seen_with',
  'alongside',
];

// ─── Main pass ───────────────────────────────────────────────────────────────

export function runHygiene(db: RobinDb, now: Date = new Date()): HygieneResult {
  const result: HygieneResult = {
    relationsDeleted: 0,
    relationsDeduped: 0,
    entitiesDeleted: 0,
    entitiesAutoCulled: 0,
    blocklistGrown: 0,
    orphansDeleted: 0,
  };
  const ts = now.toISOString();

  // Snapshot which entity IDs had at least one relation before this pass.
  // Used at the end to avoid sweeping entities that became orphaned only because
  // their noise-relation partner was deleted during this pass (e.g. Kevin connected to mcp__*).
  const connectedAtStart = new Set(
    (
      db
        .prepare(
          'SELECT subject_id AS id FROM relations UNION SELECT object_id AS id FROM relations',
        )
        .all() as Array<{ id: number }>
    ).map((r) => r.id),
  );

  // 2. Relation cleanup — delete blocked predicates (safety net)
  const placeholders = BLOCKED_PREDICATES.map(() => '?').join(',');
  const relDel = db
    .prepare(`DELETE FROM relations WHERE predicate IN (${placeholders})`)
    .run(...BLOCKED_PREDICATES);
  result.relationsDeleted = relDel.changes;

  // 2b. Relation dedup — collapse duplicate (subject, predicate, object) triples to a
  // single row, keeping the earliest (MIN id). The biographer writes one relation per
  // source event, so a fact re-extracted from many sessions accumulates identical
  // edges; the graph is read existence-based (entity.ts uses SELECT DISTINCT), so the
  // copies carry no signal and only bloat the graph. No fact is lost — every deleted
  // row's triple keeps its MIN-id survivor.
  const dedup = db
    .prepare(`
      DELETE FROM relations
      WHERE id NOT IN (SELECT MIN(id) FROM relations GROUP BY subject_id, predicate, object_id)
    `)
    .run();
  result.relationsDeduped = dedup.changes;

  // 3. Retroactive blocklist sweep — delete entities now in blocklist
  const blocklisted = db
    .prepare(`
    SELECT e.id, e.canonical_name, e.type
    FROM entities e
    JOIN noise_blocklist nb ON LOWER(e.canonical_name) = LOWER(nb.name)
  `)
    .all() as EntityRow[];
  for (const e of blocklisted) {
    db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?').run(e.id, e.id);
    db.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
    result.entitiesDeleted++;
  }

  // 4. Tier 1 pattern scan — delete matches, add to noise_blocklist
  const addToBlocklist = db.prepare(`
    INSERT OR IGNORE INTO noise_blocklist (name, reason, source, added_at)
    VALUES (?, ?, 'hygiene', ?)
  `);
  const allEntities = db
    .prepare('SELECT id, type, canonical_name, profile FROM entities')
    .all() as EntityRow[];
  for (const e of allEntities) {
    const reason = isCrossTypeNoise(e) ?? isTier1Noise(e);
    if (!reason) continue;
    db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?').run(e.id, e.id);
    db.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
    result.entitiesDeleted++;
    const info = addToBlocklist.run(e.canonical_name, reason, ts);
    if (info.changes > 0) result.blocklistGrown++;
  }

  // 5. Tier 2 signal scan — auto-cull score-≥2 thing/topic entities.
  // Unlike Tier 1, score-based culls do NOT add to noise_blocklist: if biographer
  // re-extracts the same name from a future mention with real context, it gets a
  // second chance. Tier 2 leans aggressive intentionally — graph bloat is a
  // worse failure mode than re-extracting a legit entity later.
  const remaining = db
    .prepare(
      "SELECT id, type, canonical_name, profile FROM entities WHERE LOWER(type) IN ('thing', 'topic')",
    )
    .all() as EntityRow[];
  for (const e of remaining) {
    const relCount = (
      db
        .prepare('SELECT COUNT(*) AS c FROM relations WHERE subject_id = ? OR object_id = ?')
        .get(e.id, e.id) as { c: number }
    ).c;
    if (scoreTier2(e, relCount) < 2) continue;
    db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?').run(e.id, e.id);
    db.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
    result.entitiesDeleted++;
    result.entitiesAutoCulled++;
  }

  // 6. Orphan sweep — delete entities with zero relations that were ALSO orphaned at pass start.
  //    Entities that had relations at the start but lost them due to Tier 1 deletions (e.g. an
  //    entity connected only to a deleted noise entity) are NOT swept here — they may be
  //    legitimate entities that simply lost a bad connection.
  const orphans = db
    .prepare(`
    SELECT id, canonical_name FROM entities
    WHERE id NOT IN (SELECT subject_id FROM relations UNION SELECT object_id FROM relations)
  `)
    .all() as Array<{ id: number; canonical_name: string }>;
  for (const o of orphans) {
    if (connectedAtStart.has(o.id)) continue; // was connected before this pass — skip
    db.prepare('DELETE FROM entities WHERE id = ?').run(o.id);
    result.orphansDeleted++;
  }

  // 7. Log — write hygiene.run event
  db.prepare(`
    INSERT INTO events (ts, kind, source, status, payload)
    VALUES (?, 'hygiene.run', 'dream', 'ok', ?)
  `).run(ts, JSON.stringify(result));

  return result;
}

// ─── Blocklist loader (for biographer integration) ───────────────────────────

export function loadNoiseBlocklist(db: RobinDb): Set<string> {
  const rows = db.prepare('SELECT name FROM noise_blocklist').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

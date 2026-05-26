import type { RobinDb } from '../memory/db.ts';

export interface HygieneResult {
  relationsDeleted: number;
  entitiesDeleted: number;
  entitiesFlagged: number;
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
const CODE_SYNTAX_RE = /(?:=>|::|`|^\{|^\[|^\(|var\(--|px\b|rem\b|width:|height:|background:|border:)/;
const MCP_TOOL_RE = /^mcp__/;
const CLI_CMD_RE = /^(?:git|pnpm|npm|npx|yarn|node|tsx|tsc|bun|deno|python|pip|cargo|rustc)\s/;
const DEV_JARGON_RE =
  /(?:^|[\s-])(?:ci|cd|lock|pid|dispatch|cron|daemon|cursor|script|hash|protocol|liveness|early-exit|launchd|scheduler|tick|heartbeat|stderr|stdout|stacktrace|traceback|queue|backlog|workflow|gitleaks|biographer|disambiguation|chunk|cursor-rule|cache|route|schema|codebase|session-id|handoff|wordmark|webhook|endpoint|middleware|refactor|regex|callback|payload|serializ|deserializ|upsert|backfill|rollback|shim|polyfill|monorepo|turbopack|bundler|transpil|lint|typecheck|monkeypatch|hotfix|bugfix|debounce|throttle|mutex|semaphore|subagent|antipattern|accessor|telemetry|migration|worktree|wrappers|prune|singleton|crud)(?:$|[\s-])/i;

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
  if (DB_TABLE_REF_RE.test(name)) return 'db_table_ref';
  if (CODE_SYNTAX_RE.test(name)) return 'code_syntax';
  if (CLI_CMD_RE.test(name)) return 'cli_command';
  if (DEV_JARGON_RE.test(name)) return 'dev_jargon';

  const words = name.split(/\s+/);
  if (words.length >= 6) return 'sentence_length';

  return null;
}

// ─── Tier 2: borderline scoring ──────────────────────────────────────────────

const COMMON_SINGLE_WORDS = new Set([
  'state', 'context', 'agent', 'check', 'open', 'message', 'signal',
  'type', 'scope', 'status', 'mode', 'event', 'action', 'query',
  'source', 'target', 'level', 'stage', 'block', 'entry', 'path',
  'key', 'link', 'run', 'log', 'push', 'pull', 'load', 'call',
  'flag', 'hook', 'rule', 'pipe', 'node', 'port', 'host', 'view',
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
  'occurs_with', 'related_to', 'associated_with', 'mentioned_with',
  'appears_with', 'co-occurs_with', 'co_occurs_with', 'linked_to',
  'connected_to', 'seen_with', 'alongside',
];

// ─── Main pass ───────────────────────────────────────────────────────────────

export function runHygiene(db: RobinDb, now: Date = new Date()): HygieneResult {
  const result: HygieneResult = {
    relationsDeleted: 0,
    entitiesDeleted: 0,
    entitiesFlagged: 0,
    blocklistGrown: 0,
    orphansDeleted: 0,
  };
  const ts = now.toISOString();

  // Snapshot which entity IDs had at least one relation before this pass.
  // Used at the end to avoid sweeping entities that became orphaned only because
  // their noise-relation partner was deleted during this pass (e.g. Kevin connected to mcp__*).
  const connectedAtStart = new Set(
    (db.prepare('SELECT subject_id AS id FROM relations UNION SELECT object_id AS id FROM relations').all() as Array<{ id: number }>)
      .map((r) => r.id),
  );

  // 2. Relation cleanup — delete blocked predicates (safety net)
  const placeholders = BLOCKED_PREDICATES.map(() => '?').join(',');
  const relDel = db
    .prepare(`DELETE FROM relations WHERE predicate IN (${placeholders})`)
    .run(...BLOCKED_PREDICATES);
  result.relationsDeleted = relDel.changes;

  // 3. Retroactive blocklist sweep — delete entities now in blocklist
  const blocklisted = db.prepare(`
    SELECT e.id, e.canonical_name, e.type
    FROM entities e
    JOIN noise_blocklist nb ON LOWER(e.canonical_name) = LOWER(nb.name)
  `).all() as EntityRow[];
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
  const allEntities = db.prepare('SELECT id, type, canonical_name, profile FROM entities').all() as EntityRow[];
  for (const e of allEntities) {
    const reason = isTier1Noise(e);
    if (!reason) continue;
    db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?').run(e.id, e.id);
    db.prepare('DELETE FROM entities WHERE id = ?').run(e.id);
    result.entitiesDeleted++;
    const info = addToBlocklist.run(e.canonical_name, reason, ts);
    if (info.changes > 0) result.blocklistGrown++;
  }

  // 5. Tier 2 signal scan — score remaining thing/topic entities, flag those with score ≥ 2
  const remaining = db.prepare(
    "SELECT id, type, canonical_name, profile FROM entities WHERE LOWER(type) IN ('thing', 'topic')",
  ).all() as EntityRow[];
  const alreadyFlagged = new Set(
    (db.prepare('SELECT entity_id FROM hygiene_review WHERE resolved_at IS NULL').all() as Array<{ entity_id: number }>)
      .map((r) => r.entity_id),
  );
  const insertFlag = db.prepare(`
    INSERT INTO hygiene_review (entity_id, entity_name, entity_type, reason, signals, flagged_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const e of remaining) {
    if (alreadyFlagged.has(e.id)) continue;
    const relCount = (
      db.prepare('SELECT COUNT(*) AS c FROM relations WHERE subject_id = ? OR object_id = ?').get(e.id, e.id) as { c: number }
    ).c;
    const score = scoreTier2(e, relCount);
    if (score < 2) continue;
    const reasons: string[] = [];
    const t = e.type.toLowerCase();
    if (t === 'thing' || t === 'topic') reasons.push(`type=${e.type}`);
    if (!e.profile) reasons.push('no profile');
    if (relCount <= 1) reasons.push(`${relCount} relation${relCount === 1 ? '' : 's'}`);
    const words = e.canonical_name.trim().split(/\s+/);
    if (words.length === 1 && COMMON_SINGLE_WORDS.has(words[0].toLowerCase())) reasons.push('common single word');
    insertFlag.run(e.id, e.canonical_name, e.type, reasons.join(', '), score, ts);
    result.entitiesFlagged++;
  }

  // 6. Orphan sweep — delete entities with zero relations that were ALSO orphaned at pass start.
  //    Entities that had relations at the start but lost them due to Tier 1 deletions (e.g. an
  //    entity connected only to a deleted noise entity) are NOT swept here — they may be
  //    legitimate entities that simply lost a bad connection.
  const orphans = db.prepare(`
    SELECT id, canonical_name FROM entities
    WHERE id NOT IN (SELECT subject_id FROM relations UNION SELECT object_id FROM relations)
  `).all() as Array<{ id: number; canonical_name: string }>;
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

// ─── Resolution ──────────────────────────────────────────────────────────────

export function resolveHygieneItem(
  db: RobinDb,
  reviewId: number,
  resolution: 'keep' | 'delete',
): void {
  const row = db.prepare('SELECT * FROM hygiene_review WHERE id = ?').get(reviewId) as
    | { id: number; entity_id: number; entity_name: string; resolved_at: string | null }
    | undefined;
  if (!row) throw new Error(`hygiene_review row ${reviewId} not found`);
  if (row.resolved_at) throw new Error(`hygiene_review row ${reviewId} already resolved`);

  const ts = new Date().toISOString();
  if (resolution === 'delete') {
    db.prepare('DELETE FROM relations WHERE subject_id = ? OR object_id = ?').run(
      row.entity_id,
      row.entity_id,
    );
    // Disable FK enforcement while deleting the entity so that the ON DELETE CASCADE on
    // hygiene_review.entity_id does not wipe the review row — we need to update it below.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM entities WHERE id = ?').run(row.entity_id);
    db.pragma('foreign_keys = ON');
    db.prepare(`
      INSERT OR IGNORE INTO noise_blocklist (name, reason, source, added_at)
      VALUES (?, 'user_flagged_delete', 'user_resolve', ?)
    `).run(row.entity_name, ts);
  }
  db.prepare('UPDATE hygiene_review SET resolved_at = ?, resolution = ? WHERE id = ?').run(
    ts,
    resolution,
    reviewId,
  );
}

// ─── Blocklist loader (for biographer integration) ───────────────────────────

export function loadNoiseBlocklist(db: RobinDb): Set<string> {
  const rows = db.prepare('SELECT name FROM noise_blocklist').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

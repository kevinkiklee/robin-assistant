import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { UsageLedger } from '../../../agent/usage-ledger.ts';
import {
  checkPredictionCreation,
  notePredictionInserted,
} from '../../../brain/cognition/prediction-gate.ts';
import { compactRegistry } from '../../../brain/cognition/predictions/readers.ts';
import { PredictionSpecSchema, validateSpec } from '../../../brain/cognition/predictions/spec.ts';
import {
  applyRecommendGate,
  SessionRecCounter,
} from '../../../brain/cognition/recommendations/index.ts';
import { buildDispatcherFromConfig } from '../../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import { believe, normalizeTopic, recallBelief } from '../../../brain/memory/belief.ts';
import {
  countPendingCandidates,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from '../../../brain/memory/belief-candidate.ts';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { isPersonalDomain, PERSONAL_DOMAINS } from '../../../brain/memory/domains.ts';
import {
  findEntity,
  getEntity,
  relatedEntities,
  upsertEntity,
  withFreshProfile,
} from '../../../brain/memory/entity.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { recall } from '../../../brain/memory/recall.ts';
import type { Logger } from '../../../integrations/_runtime/types.ts';
import { loadModels, loadPolicies } from '../../../kernel/config/load.ts';
import {
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  schedulerProgressingInvariant,
  userDataWritableInvariant,
  vecIndexSyncedInvariant,
} from '../../../kernel/invariants/builtins/index.ts';
import { runInvariants } from '../../../kernel/invariants/runner.ts';
import { LOADED_DEEP_HASH, readBuildStamp } from '../../../lib/build-stamp.ts';
import {
  checkInboundArgs,
  inboundRefusal,
  reservedKindRefusal,
  reservedMemoryKind,
  TRUSTED_KIND_PREFIXES,
} from '../../../lib/discretion/policy.ts';
import { UNTRUSTED_NOTE, wrapUntrusted } from '../../../lib/discretion/wrap-untrusted.ts';
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';
import { loadEnvFile } from '../../../lib/secrets/load-env.ts';
import { VERSION } from '../../../lib/version.ts';
import { defaultSkillRoots } from '../../../skills/_runtime/loader.ts';
import {
  assertDeepHashCoherent,
  createReloadableDispatch,
  type ReloadableDispatch,
  type ToolCb,
} from '../hot-reload.ts';
import { runSkillTool, type SkillToolArgs, skillCatalogDescription } from './skill-tool.ts';

export interface CoreServerDeps {
  db: RobinDb;
  llm: LLMDispatcher | null;
}

export function buildCoreDeps(): CoreServerDeps {
  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  let llm: LLMDispatcher | null = null;
  try {
    const models = loadModels(userData);
    llm = buildDispatcherFromConfig(models, { lenient: true, ledger: new UsageLedger(db) });
  } catch {
    llm = null;
  }
  return { db, llm };
}

/**
 * A prediction claim must be human-meaningful. Rejects empty/whitespace and the
 * reserved `__sentinel__` marker pattern — an earlier list-open code path inserted
 * a `__list_open__` sentinel as a real prediction row (orphaned, unresolvable,
 * confidence 0.0). Internal markers must never be persisted as user predictions.
 */
export function isValidPredictionClaim(claim: string): boolean {
  const trimmed = claim.trim();
  if (trimmed.length === 0) return false;
  if (/^__.*__$/.test(trimmed)) return false;
  return true;
}

/**
 * Tools safe to expose on a surface Robin doesn't control — the remote MCP
 * endpoint claude.ai connects to. Membership requires that no code path reachable
 * from that surface writes. Three of these are mixed-mode and depend on
 * `readOnly` to disarm their write branch: `get` otherwise upserts a missing
 * entity, `alerts` otherwise acks, `power` otherwise rewrites policies.yaml.
 * `explain` is absent for a different reason — it returns a placeholder stub, so
 * advertising it would spend tokens describing a no-op.
 */
export const READ_ONLY_TOOLS = [
  'recall',
  'find_entity',
  'get',
  'related_entities',
  'list',
  'recall_belief',
  'review_beliefs',
  'journal',
  'audit',
  'metrics',
  'health',
  'alerts',
  'power',
  'integration_status',
  'skill',
] as const;

/**
 * Writes reachable from a remote surface when the caller holds the `robin:write`
 * scope. Deliberately a subset of everything that writes: these append to the
 * memory ledger and are individually reversible. Excluded on purpose are the
 * tools that execute rather than record — `agent` (spends money, runs code),
 * `run` (fires jobs), `ingest` — and `power`, which changes daemon
 * state rather than memory.
 */
export const REMOTE_WRITE_TOOLS = [
  'remember',
  'believe',
  'predict',
  'recommend',
  'record_correction',
  'resolve_belief_candidate',
] as const;

export interface CoreServerOptions {
  /**
   * Register only these tools. Omit for the full local surface — a tool reaches
   * a remote client only by being named here, so anything added later is
   * local-only until someone opts it in.
   */
  allow?: ReadonlySet<string>;
  /**
   * Refuse the mutating branches of otherwise-read tools: `get` stops creating
   * entities it can't find, `alerts` refuses `ack`, `power` serves `status` only.
   * Registration is gated by name, so a tool with a write path can only be
   * exposed safely if that path can be turned off.
   */
  readOnly?: boolean;
  /**
   * Whether this server instance owns its DB handle and may hot-reload.
   * Default true.
   *
   * The remote HTTP surface (system/surfaces/mcp/remote/server.ts) builds a
   * server PER REQUEST against `deps.db` — a process-wide handle SHARED
   * across every concurrent request, not owned by any single call. A reload
   * firing there would `closeDb` that shared handle out from under every
   * other in-flight request the moment a build landed while a request was
   * being served (task-4 review finding 1). There is no way to make
   * per-request reload safe against a caller-owned shared DB, so passing
   * `false` disables the whole apparatus honestly instead of half-working:
   * callbacks run exactly as registered at startup, unwrapped, and staleness
   * on that surface is fixed only by restarting the remote process — same as
   * before this feature existed.
   */
  reloadable?: boolean;
  /**
   * Override for where `dist/.build-stamp` is resolved from. Test-only:
   * production callers (core/run.ts, remote/server.ts) never set this — see
   * `defaultRepoRoot()`.
   */
  repoRoot?: string;
}

/**
 * Everything a tool callback closure needs, now that the callbacks live in
 * their own factory (`buildToolCallbacks`) instead of being built inline
 * inside `buildCoreServer`. `readOnly` is included alongside `db`/`llm`
 * because it isn't just a registration-time filter — `get`, `power`, and
 * `alerts` branch on it at CALL time, so a hot-reloaded table must be built
 * with the exact same value the server was originally started with, not a
 * default.
 */
export interface ToolCallbackDeps {
  db: RobinDb;
  llm: LLMDispatcher | null;
  readOnly: boolean;
}

interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: ZodRawShapeCompat | AnySchema;
}

export interface ToolCallbackEntry {
  config: ToolConfig;
  cb: ToolCb;
}

/**
 * Builds the full name→{config, cb} tool table. Extracted out of
 * `buildCoreServer` so it can be re-invoked in isolation: `buildCoreServer`
 * calls it once at startup for the initial registration, and the hot-reload
 * `rebuild` closure below cache-bust-imports this same module and calls it
 * again with fresh deps to produce a replacement dispatch table without
 * re-registering anything with the MCP SDK (which only supports registering
 * a tool once).
 */
/**
 * The per-session daily `recommend` cap (audit 2026-10-02: 72 recs in one evening). A
 * stdio MCP server is one client session, so the counter is per-process — stashed on
 * globalThis so a hot-reload rebuild of the callbacks doesn't reset the allowance.
 */
const REC_SESSION_CAP_KEY = Symbol.for('robin.recommend.sessionCap');
function recSessionCap(): SessionRecCounter {
  const g = globalThis as unknown as Record<symbol, SessionRecCounter | undefined>;
  g[REC_SESSION_CAP_KEY] ??= new SessionRecCounter();
  return g[REC_SESSION_CAP_KEY];
}

export function buildToolCallbacks(deps: ToolCallbackDeps): Map<string, ToolCallbackEntry> {
  const { db, llm, readOnly } = deps;
  const callbacks = new Map<string, ToolCallbackEntry>();

  function add<InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
    name: string,
    config: { title?: string; description?: string; inputSchema?: InputArgs },
    cb: ToolCallback<InputArgs>,
  ): void {
    callbacks.set(name, { config: config as ToolConfig, cb: cb as ToolCb });
  }

  add(
    'recall',
    {
      description: 'Search memory by query (lexical + vector hybrid). Returns ranked snippets.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().int().optional().describe('Max results (default 10)'),
        mode: z.enum(['lex', 'vec', 'hybrid']).optional().describe('Search mode'),
      }),
    },
    async ({ query, limit, mode }) => {
      const hits = await recall(db, llm, query, { limit, mode });
      return { content: [{ type: 'text' as const, text: renderMemoryRows(hits, ['body']) }] };
    },
  );

  add(
    'remember',
    {
      description: 'Write a fact, observation, or memory to the event log.',
      inputSchema: z.object({
        content: z.string().describe('What to remember'),
        kind: z.string().optional().describe("Event kind tag (default: 'memory.remember')"),
        source: z.string().optional().describe("Source label (default: 'mcp')"),
      }),
    },
    async ({ content, kind, source }) => {
      if (kind && reservedMemoryKind(kind)) return reservedKindRefusal(kind);
      const r = ingest(db, llm, {
        kind: kind ?? 'memory.remember',
        source: source ?? 'mcp',
        content,
      });
      // `embedded` used to round-trip through this response when embedding was inline.
      // It's now deferred to the embedder job, so the response reports only the
      // event id; callers shouldn't expect immediate vector recall on the new row.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ eventId: r.eventId, embed: 'deferred' }),
          },
        ],
      };
    },
  );

  add(
    'find_entity',
    {
      description: 'Search entities by name (partial match).',
      inputSchema: z.object({
        query: z.string().describe('Name to search'),
        type: z.string().optional().describe('Filter by entity type'),
      }),
    },
    async ({ query, type }) => {
      const hits = findEntity(db, query, type).map((h) => withFreshProfile(db, h));
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  add(
    'get',
    {
      description: 'Generic getter for entity by id or canonical lookup by type+key.',
      inputSchema: z.object({
        type: z.string().describe('Entity type or "entity"'),
        id: z.number().int().optional().describe('Numeric id to fetch'),
        key: z.string().optional().describe('Canonical name (used with type)'),
      }),
    },
    async ({ type, id, key }) => {
      if (id !== undefined) {
        const e = getEntity(db, id);
        const result = e ? withFreshProfile(db, e) : e;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }
      if (key) {
        // Lookup-only on a read-only surface. The local path upserts so callers
        // can address an entity before it exists; doing that remotely would let
        // a read request write rows, which is why `get` was previously withheld
        // from the remote surface entirely.
        if (readOnly) {
          const found = findEntity(db, key, type).find(
            (e) => e.canonical_name.toLowerCase() === key.toLowerCase(),
          );
          const result = found ? withFreshProfile(db, found) : null;
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        }
        const e = upsertEntity(db, type, key);
        const result = withFreshProfile(db, e);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'must provide id or key' }) },
        ],
      };
    },
  );

  add(
    'related_entities',
    {
      description:
        'Graph neighbours of an entity, 1 or 2 hops out. Use after find_entity to see what an entity is connected to.',
      inputSchema: z.object({
        id: z.number().int().describe('Entity id (from find_entity)'),
        hops: z.number().int().min(1).max(2).optional().describe('1 (default) or 2'),
      }),
    },
    async ({ id, hops }) => {
      const rows = relatedEntities(db, id, hops ?? 1);
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  add(
    'integration_status',
    {
      description:
        'Per-integration health: last sync, error state, status. With `name`, full per-key state for that integration; without, a compact one-row-per-integration summary.',
      inputSchema: z.object({
        name: z.string().optional().describe('Specific integration, or omit for all'),
      }),
    },
    async ({ name }) => {
      if (name) {
        // Value length is capped so a runaway extension can't push megabytes
        // through a single call.
        const rows = db
          .prepare(
            'SELECT integration_name, key, substr(value, 1, 4096) AS value, updated_at FROM integration_state WHERE integration_name = ?',
          )
          .all(name) as unknown[];
        return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
      }
      const { runIntegrationsReport } = await import('../../cli/integrations.ts');
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(runIntegrationsReport(), null, 2) },
        ],
      };
    },
  );

  add(
    'list',
    {
      description:
        "Generic lister for entities, events, jobs, predictions, corrections. For events, supports optional `kind` and `since` filters so callers can pull e.g. the last 3 `v2.whoop` ticks or today's `v2.lunch_money` transactions.",
      inputSchema: z.object({
        type: z
          .enum(['entities', 'events', 'jobs', 'predictions', 'corrections', 'recommendations'])
          .describe('What to list'),
        limit: z.number().int().optional().describe('Max rows (default 20)'),
        kind: z
          .string()
          .optional()
          .describe(
            "When type=events: filter by event kind (e.g. 'v2.whoop', 'session.captured'). Ignored otherwise.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "When type=events: ISO timestamp lower bound (e.g. '2026-05-21T00:00:00Z'). Ignored otherwise.",
          ),
      }),
    },
    async ({ type, limit, kind, since }) => {
      const lim = limit ?? 20;
      let rows: unknown[] = [];
      switch (type) {
        case 'entities':
          rows = db
            .prepare('SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?')
            .all(lim) as unknown[];
          break;
        case 'events': {
          // Build WHERE clauses + matching parameter list together so positional
          // binding stays in lockstep — no string-interpolated user input ever
          // reaches the SQL.
          // Always table-qualify column names: when `kind` is present we LEFT JOIN
          // events_content, which also has a `ts` column. An unqualified `ts >= ?`
          // then throws SQLite's "ambiguous column name: ts". Qualifying both columns
          // is safe in the no-join path too.
          const where: string[] = [];
          const params: (string | number)[] = [];
          if (kind) {
            where.push('events.kind = ?');
            params.push(kind);
          }
          if (since) {
            where.push('events.ts >= ?');
            params.push(since);
          }
          const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
          // When kind is filtered, also surface the content body so a single call
          // gets both metadata + the event payload the caller actually wants. Without
          // this, daily-brief would need a second `recall` call per source which
          // doesn't filter by kind at all.
          if (kind) {
            params.push(lim);
            rows = db
              .prepare(
                `SELECT events.id, events.ts, events.kind, events.source, events.status, events.payload, events_content.body
                 FROM events LEFT JOIN events_content ON events_content.id = events.content_ref
                 ${whereClause} ORDER BY events.ts DESC LIMIT ?`,
              )
              .all(...params) as unknown[];
          } else {
            params.push(lim);
            rows = db
              .prepare(
                `SELECT id, ts, kind, source, status FROM events ${whereClause} ORDER BY events.ts DESC LIMIT ?`,
              )
              .all(...params) as unknown[];
          }
          break;
        }
        case 'jobs':
          rows = db
            .prepare('SELECT * FROM jobs ORDER BY scheduled_at DESC LIMIT ?')
            .all(lim) as unknown[];
          break;
        case 'predictions':
          rows =
            (
              db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'")
                .all() as unknown[]
            ).length > 0
              ? (db
                  .prepare('SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?')
                  .all(lim) as unknown[])
              : [];
          break;
        case 'corrections':
          rows =
            (
              db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'")
                .all() as unknown[]
            ).length > 0
              ? (db
                  .prepare('SELECT * FROM corrections ORDER BY ts DESC LIMIT ?')
                  .all(lim) as unknown[])
              : [];
          break;
        case 'recommendations':
          // Same table-exists guard as the rest: `list` must degrade to an empty
          // result on a DB that predates the migration, not throw.
          rows =
            (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name='recommendations'",
                )
                .all() as unknown[]
            ).length > 0
              ? (db
                  .prepare('SELECT * FROM recommendations ORDER BY created_at DESC LIMIT ?')
                  .all(lim) as unknown[])
              : [];
          break;
      }
      // Event rows carry body + payload text that may be third-party (email subjects).
      const text =
        type === 'events'
          ? renderMemoryRows(rows, ['body', 'payload'])
          : JSON.stringify(rows, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  add(
    'predict',
    {
      description:
        'Record a prediction with confidence and optional deadline. Used to track calibration over time. Name sourceStream when the resolution method reads an integration stream; predictions against dead/stale streams are rejected at creation. Nightly agent runs are capped at 2 predictions.',
      inputSchema: z.object({
        claim: z.string().describe('What you are predicting will (or will not) happen'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe('Probability assigned to the claim being true (0..1)'),
        deadline: z.string().optional().describe('ISO date when this can be resolved'),
        resolution_method: z.string().optional().describe('How to check if it came true'),
        external_id: z.string().optional().describe('Idempotency key; same key upserts'),
        sourceStream: z
          .string()
          .optional()
          .describe(
            'events.source (or source.metric) the resolution method reads — REQUIRED when resolution depends on an integration stream; creation is rejected if that stream is stale (>14d)',
          ),
        spec: PredictionSpecSchema.optional().describe(
          `Machine-checkable resolution — claim TRUE iff <reading> <op> <threshold>, read at \`at\` (default: deadline). Give one whenever the claim is about whoop/finance/photos/linear data so the nightly resolver settles it right/wrong instead of 'unverifiable'. Series metrics take agg value|mean|min|max|sum (non-value needs window_days); ~ = windowed (window_days required); @ = state at \`at\`; (key) = key required. ${compactRegistry()}. Format: docs/design/2026-10-03-prediction-specs.md`,
        ),
      }),
    },
    async ({ claim, confidence, deadline, resolution_method, external_id, sourceStream, spec }) => {
      if (!isValidPredictionClaim(claim)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Invalid prediction claim: must be non-empty and not a reserved __sentinel__ marker.',
            },
          ],
        };
      }
      let specJson: string | null = null;
      if (spec !== undefined) {
        const v = validateSpec(spec, deadline);
        if (!v.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Invalid prediction spec: ${v.error}` }],
          };
        }
        specJson = JSON.stringify(v.spec);
      }
      if (external_id) {
        const existing = db
          .prepare('SELECT id FROM predictions WHERE external_id = ?')
          .get(external_id) as { id: number } | undefined;
        if (existing) {
          // A revision without `spec` keeps the stored one.
          db.prepare(
            'UPDATE predictions SET claim=?, confidence=?, deadline=?, resolution_method=?, spec=COALESCE(?, spec) WHERE id=?',
          ).run(
            claim,
            confidence,
            deadline ?? null,
            resolution_method ?? null,
            specJson,
            existing.id,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ id: existing.id, upserted: true }),
              },
            ],
          };
        }
      }
      // Creation gate (design 2026-08-10 §4): reject dead/stale source streams and
      // enforce the per-agent-run cap. Upserts above are revisions, not creations,
      // so they bypass the gate.
      const gate = checkPredictionCreation(db, { sourceStream });
      if (!gate.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Prediction rejected: ${gate.reason}` }],
        };
      }
      const info = db
        .prepare(
          'INSERT INTO predictions (claim, confidence, deadline, resolution_method, external_id, spec) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          claim,
          confidence,
          deadline ?? null,
          resolution_method ?? null,
          external_id ?? null,
          specJson,
        );
      notePredictionInserted();
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ id: Number(info.lastInsertRowid) }) },
        ],
      };
    },
  );

  add(
    'recommend',
    {
      description:
        'Record a substantive recommendation Robin makes (mirrors `predict` for advice). Captured as a first-class `open` recommendation so the loop can later detect whether the operator acted on it — feeding calibration (which advice lands) and the habit engine. Log one when you make a real recommendation, the same discipline as logging a prediction. `subject` is the short canonical name of the recommended thing ("Acme kettle") — it is the linker\'s match key, so keep it the name the operator would act on. A rec is advice the operator might act on — their next action — NOT comparative verdicts generated as content inside guides; don\'t log those. Duplicate open subject+verdict returns {action:"duplicate"} instead of inserting; a changed verdict or an overlapping subject supersedes the older rec automatically. Past 15 new recs in one session per day, further recs are logged as {action:"suppressed"} and stay out of the open-loop list — log only the ones the operator will actually act on.',
      inputSchema: z.object({
        subject: z
          .string()
          .describe('Short canonical name of the recommended thing (the linker match key)'),
        claim: z.string().describe('The recommendation / advice text'),
        reasoning: z.string().optional().describe('Why Robin recommended it'),
        verdict: z
          .enum(['buy', 'skip', 'wait', 'try', 'avoid', 'other'])
          .optional()
          .describe('Optional stance on the recommended thing'),
        domain: z
          .string()
          .describe('Calibration-grouping bucket — a PERSONAL_DOMAINS domain (e.g. finance)'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("Robin's confidence in the recommendation (0..1)"),
        expiresAt: z
          .string()
          .optional()
          .describe('ISO timestamp; after this an unacted rec resolves not_acted'),
      }),
    },
    async ({ subject, claim, reasoning, verdict, domain, confidence, expiresAt }) => {
      if (!isPersonalDomain(domain)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Invalid domain '${domain}': must be one of ${PERSONAL_DOMAINS.join(', ')}.`,
            },
          ],
        };
      }
      // Route through the creation gate (design 2026-08-10 §4): a duplicate open
      // subject+verdict bumps evidence instead of inserting; a changed verdict inserts
      // and supersedes the prior stance(s). The provenance event — a
      // `memory.recommendation` ingest whose id becomes `source_event_id` (FK → events
      // ON DELETE SET NULL, survives event purges) — is only written when a row is
      // actually inserted, so the duplicate path leaves no orphan event.
      const result = applyRecommendGate(
        db,
        { subject, claim, reasoning, verdict, domain, confidence, expiresAt },
        () =>
          ingest(db, llm, {
            kind: 'memory.recommendation',
            source: 'mcp',
            content: `${verdict ? `[${verdict}] ` : ''}${subject}: ${claim}`,
            payload: { subject, verdict: verdict ?? null, domain, confidence },
          }).eventId,
        { sessionCap: recSessionCap() },
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  add(
    'believe',
    {
      description:
        'Persist a topic-keyed belief-update. Auto-supersedes the prior belief for the topic; same-day repeats upsert in place. Topic is normalized (lowercase/dash). Use recall_belief to read current truth.',
      inputSchema: z.object({
        topic: z.string().describe('Dotted topic key, e.g. bread.crust.after_steam'),
        claim: z.string().describe('The belief, in natural language'),
        supersedes: z.number().int().optional().describe('Override: event_id of the prior belief'),
        confidence: z.number().min(0).max(1).optional().describe('0..1, metadata only'),
        sources: z.array(z.number().int()).optional().describe("Today's event_ids that drove this"),
        retracted: z.boolean().optional().describe('True = no longer hold a belief here'),
      }),
    },
    async ({ topic, claim, supersedes, confidence, sources, retracted }) => {
      const r = believe(db, llm, {
        topic,
        claim,
        supersedes,
        confidence,
        sources,
        retracted,
      });
      // Surface the dev-artifact rejection explicitly rather than letting the
      // caller treat eventId -1 as a real write.
      if (r.blocked === 'dev-artifact') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ...r,
                note: 'Skipped: claim is about Robin/engineering internals, not a durable life-fact. Beliefs are personal-only.',
              }),
            },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  add(
    'recall_belief',
    {
      description:
        'Read current belief truth. With topic: the latest belief (or full chain if history=true). Without topic: latest belief per topic (enumerate what Robin currently believes).',
      inputSchema: z.object({
        topic: z.string().optional().describe('Topic key; omit to enumerate all topics'),
        history: z.boolean().optional().describe('With topic: return the full supersedes chain'),
        limit: z.number().int().optional().describe('Enumerate mode: max topics (default 50)'),
      }),
    },
    async ({ topic, history, limit }) => {
      const r = recallBelief(db, { topic, history, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  add(
    'review_beliefs',
    {
      description:
        'List machine-drafted belief candidates awaiting review (the biographer drafts these from sessions; they are NOT truth until promoted). Read-only. Defaults to pending. Returns the candidate list plus the count still pending. Use resolve_belief_candidate to promote (keep as durable truth) or reject (noise/duplicate/transient).',
      inputSchema: z.object({
        status: z
          .enum(['pending', 'promoted', 'rejected'])
          .optional()
          .describe('Filter by status (default: pending)'),
        limit: z.number().int().optional().describe('Max candidates (default 50)'),
      }),
    },
    async ({ status, limit }) => {
      const candidates = listBeliefCandidates(db, {
        status: status ?? 'pending',
        ...(limit !== undefined ? { limit } : {}),
      });
      const pending = countPendingCandidates(db);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ pending, candidates }, null, 2) },
        ],
      };
    },
  );

  add(
    'resolve_belief_candidate',
    {
      description:
        'Resolve a pending belief candidate. action=promote when the claim is a durable declarative fact worth keeping as truth — it routes through believe() (inheriting supersession) and returns the new belief event id. action=reject when the claim is noise, a duplicate, or transient. Resolving an already-resolved or missing candidate errors.',
      inputSchema: z.object({
        id: z.number().int().describe('Candidate id (from review_beliefs)'),
        action: z
          .enum(['promote', 'reject'])
          .describe('promote = durable truth; reject = noise/duplicate/transient'),
        reason: z.string().optional().describe('Optional note recorded with the resolution'),
      }),
    },
    async ({ id, action, reason }) => {
      const r = resolveBeliefCandidate(db, llm, id, action, reason);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  add(
    'record_correction',
    {
      description:
        'Record a correction: what Robin said vs what is actually right. Feeds the self-learning loop.',
      inputSchema: z.object({
        what: z.string().describe('What Robin said that was wrong'),
        correction: z.string().describe('What the correct version is'),
        context: z.string().optional().describe('Optional context: where this happened'),
        topic: z
          .string()
          .optional()
          .describe(
            'Belief topic this correction refutes, if any — enables auto-retraction of the contradicted belief',
          ),
      }),
    },
    async ({ what, correction, context, topic }) => {
      const normalizedTopic = topic ? normalizeTopic(topic) : null;
      const info = db
        .prepare(`
        INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)
      `)
        .run(what, correction, context ?? null, normalizedTopic);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ id: Number(info.lastInsertRowid) }) },
        ],
      };
    },
  );

  add(
    'audit',
    {
      description:
        'Read audit log: events / refusals / corrections / power transitions / mcp calls. Metadata only by default.',
      inputSchema: z.object({
        type: z
          .enum(['events', 'refusals', 'corrections', 'predictions'])
          .describe('What to audit'),
        window: z.string().optional().describe('Window like "24h", "7d", "30d". Default 24h.'),
        limit: z.number().int().optional().describe('Max rows (default 50)'),
      }),
    },
    async ({ type, window, limit }) => {
      const lim = limit ?? 50;
      const w = window ?? '24h';
      const hours = w.endsWith('d') ? Number.parseInt(w, 10) * 24 : Number.parseInt(w, 10);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      let rows: unknown[] = [];
      switch (type) {
        case 'events':
          rows = db
            .prepare(
              `SELECT id, ts, kind, source, status FROM events WHERE ts > ? ORDER BY ts DESC LIMIT ?`,
            )
            .all(since, lim) as unknown[];
          break;
        case 'refusals':
          rows = db
            .prepare(`SELECT * FROM refusals WHERE ts > ? ORDER BY ts DESC LIMIT ?`)
            .all(since, lim) as unknown[];
          break;
        case 'corrections':
          rows = db
            .prepare(`SELECT * FROM corrections WHERE ts > ? ORDER BY ts DESC LIMIT ?`)
            .all(since, lim) as unknown[];
          break;
        case 'predictions':
          rows = db
            .prepare(
              `SELECT * FROM predictions WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(since, lim) as unknown[];
          break;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  add(
    'explain',
    {
      description:
        'Explain a recall result, action, learning step, or playbook decision. Phase 1: explanation stubs by type.',
      inputSchema: z.object({
        type: z
          .enum(['recall', 'action_trust', 'learning', 'playbook'])
          .describe('What kind of decision to explain'),
        ref: z.string().describe('Reference id, query, or descriptor'),
      }),
    },
    async ({ type, ref }) => {
      // MVP: stub explanations. Real explanation logic ships in Plan 6.
      const explanation = `[${type}] explanation for ref="${ref}" is not yet implemented; returning placeholder.`;
      return { content: [{ type: 'text' as const, text: explanation }] };
    },
  );

  add(
    'health',
    {
      description:
        'Run health invariants and return their status. Quick check on daemon + DB + integrations.',
      inputSchema: z.object({}),
    },
    async () => {
      const userData = resolveUserDataDir();
      const reports = await runInvariants([
        userDataWritableInvariant(userData),
        dbReachableInvariant(db),
        dbSchemaCurrentInvariant(db),
        dbWalSizeBoundedInvariant(db),
        vecIndexSyncedInvariant(db),
        schedulerProgressingInvariant(db, { userData }),
      ]);
      return { content: [{ type: 'text' as const, text: JSON.stringify(reports, null, 2) }] };
    },
  );

  add(
    'metrics',
    {
      description:
        'Read learning + perf metrics for a window. Returns {value, n} per metric. Pass agents:true for per-handler agent ROI: runs, spend, outcomes, last did-work.',
      inputSchema: z.object({
        kind: z.string().optional().describe("Specific metric (e.g. 'brier_30d'); omit for all"),
        window: z.string().optional().describe('Window like "7d", "30d". Default 30d.'),
        agents: z
          .boolean()
          .optional()
          .describe('Per-handler agent ROI: runs, spend, outcomes, last did-work'),
      }),
    },
    async ({ kind, window, agents }) => {
      if (agents) {
        const { agentMetricsRows } = await import('../../cli/metrics.ts');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(agentMetricsRows(db), null, 2) }],
        };
      }
      const w = window ?? '30d';
      const days = Math.min(Math.max(Number.parseInt(w, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
      let rows: unknown[] = [];
      if (kind) {
        rows = db
          .prepare(`SELECT * FROM metrics_daily WHERE metric = ? AND day >= ? ORDER BY day DESC`)
          .all(kind, since) as unknown[];
      } else {
        rows = db
          .prepare(
            `SELECT metric, day, value, n FROM metrics_daily WHERE day >= ? ORDER BY day DESC, metric`,
          )
          .all(since) as unknown[];
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  add(
    'journal',
    {
      description: 'Read the day journal — a narrative summary of what happened on a given day.',
      inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
      }),
    },
    async ({ date }) => {
      const day = date ?? new Date().toISOString().slice(0, 10);
      const row = db.prepare(`SELECT body, generated_at FROM journals WHERE day = ?`).get(day) as
        | { body: string; generated_at: string }
        | undefined;
      if (!row) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No journal for ${day}. Dream job has not yet generated one — try again after 03:00 local.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: row.body }] };
    },
  );

  add(
    'power',
    {
      description:
        'Read or change Robin power state. Actions: pause, resume, incognito, offline, online, status. Off/on are CLI-only.',
      inputSchema: z.object({
        action: z
          .enum(['pause', 'resume', 'incognito', 'offline', 'online', 'status'])
          .describe('What to do'),
        duration: z
          .string()
          .optional()
          .describe('Like "1h", "30m", "permanent" — used by incognito'),
      }),
    },
    async ({ action, duration }) => {
      const userData = resolveUserDataDir();
      const policiesPath = join(userData, 'config', 'policies.yaml');
      const policies = loadPolicies(userData);
      if (action === 'status') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(policies, null, 2) }] };
      }
      // Every other action rewrites policies.yaml — daemon state, not memory.
      // A remote caller can read the power state but never change it.
      if (readOnly) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `power: only action='status' is available on this surface (asked for '${action}')`,
            },
          ],
        };
      }
      const next = { ...policies };
      // Stamp provenance on manual transitions: set_by:'user' keeps the power
      // auto-monitor from ever auto-resuming a pause the user made deliberately,
      // and `since` feeds the scheduler-stall alarm + status output.
      const since = new Date().toISOString();
      if (action === 'pause')
        next.power = { ...next.power, state: 'paused', set_by: 'user', since };
      else if (action === 'resume')
        next.power = { ...next.power, state: 'active', set_by: 'user', since };
      else if (action === 'incognito') {
        next.capture = { ...next.capture, enabled: false };
        if (duration && duration !== 'permanent') {
          const raw = Number.parseInt(duration, 10) || 0;
          const ms = duration.endsWith('h')
            ? Math.min(raw, 720) * 3600 * 1000
            : Math.min(raw, 43200) * 60 * 1000;
          (next.capture as { expires_at?: string }).expires_at = new Date(
            Date.now() + ms,
          ).toISOString();
        } else {
          // A stale expiry from an earlier timed incognito would make "permanent" lapse at once.
          delete (next.capture as { expires_at?: string }).expires_at;
        }
      } else if (action === 'offline') next.network = { ...next.network, mode: 'offline' };
      else if (action === 'online') next.network = { ...next.network, mode: 'online' };
      writeFileSync(policiesPath, stringifyYaml(next));
      return {
        content: [
          {
            type: 'text' as const,
            text: `power.${action} applied. New state: ${JSON.stringify(next, null, 2)}`,
          },
        ],
      };
    },
  );

  add(
    'alerts',
    {
      description:
        'System health alerts — open problems Robin has detected (stale integrations, failing jobs, crash loops). action=list (default) or ack.',
      inputSchema: z.object({
        action: z.enum(['list', 'ack']).default('list'),
        id: z.number().optional().describe('alert id, required for ack'),
        all: z.boolean().optional().describe('include resolved/acked history'),
      }),
    },
    async ({ action, id, all }) => {
      const { listAlertsText, runAck } = await import('../../cli/alerts.ts');
      // `ack` mutates alert state; on a read-only surface it is refused rather
      // than silently downgraded to a list, so the caller sees why.
      if (action === 'ack' && readOnly) {
        return {
          content: [
            { type: 'text' as const, text: 'alerts: ack is not available on this surface' },
          ],
        };
      }
      const text =
        action === 'ack'
          ? id === undefined
            ? 'ack requires id'
            : runAck(db, id)
          : listAlertsText(db, { all });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // Skills — reusable methodologies (system + user). The tool description embeds
  // the catalog of valid skills (generated now, at server start) so Robin can see
  // what's available without a separate list call; `{ name }` loads one on demand.
  const skillRoots = defaultSkillRoots();
  add(
    'skill',
    {
      description: skillCatalogDescription(skillRoots),
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe('Skill to load — the directory name shown in the catalog above.'),
        action: z
          .enum(['list'])
          .optional()
          .describe('`list` returns the full catalog as data, including invalid skills + errors.'),
      }),
    },
    async (args) => {
      const result = runSkillTool(skillRoots, args as SkillToolArgs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  return callbacks;
}

/** This module's own type, referenced only for the dynamic re-import inside
 * `buildCoreServer`'s `rebuild` closure below — it needs `buildCoreDeps` and
 * `buildToolCallbacks` typed on the freshly-imported module namespace rather
 * than `any`. */
type ServerModule = typeof import('./server.ts');

/**
 * The repo root sits four directories above this module (`system/surfaces/mcp/core/`
 * in dev, `dist/surfaces/mcp/core/` compiled). NEVER derive it from
 * process.cwd() — same reasoning as `defaultRepoRoot()` in
 * system/agent/runner-entry.ts and system/kernel/invariants/doctor-set.ts:
 * both stdio MCP processes and the remote HTTP MCP process can be launched
 * from any working directory.
 */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/**
 * Hot-reload's own log channel. Deliberately not the pino `createLogger` used
 * elsewhere (daemon.ts, cognition-runner-entry.ts): those open a file
 * destination once per call, which is safe for a process that constructs its
 * logger exactly once, but `buildCoreServer` is also called once PER REQUEST
 * by the remote HTTP surface (system/surfaces/mcp/remote/server.ts) — a fresh
 * file destination per request would leak file descriptors.
 * `process.stderr.write` (same fallback-log pattern as
 * system/agent/runner-entry.ts and cognition-runner-entry.ts) is safe for the
 * stdio transport (stdout is reserved for JSON-RPC framing), is already
 * captured by whatever supervises either process, and — unlike a fresh pino
 * destination — has no per-call resource to leak.
 */
function writeHotReloadLog(level: 'info' | 'warn' | 'error', obj: unknown, msg?: string): void {
  process.stderr.write(
    `${JSON.stringify({ level, module: 'mcp-core-hot-reload', msg, ...toLogFields(obj) })}\n`,
  );
}

function toLogFields(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return { obj };
  // Plain JSON.stringify drops an Error's message/stack (non-enumerable on
  // the instance), which would otherwise silently swallow the one field a
  // rebuild-failure log line most needs.
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) =>
      v instanceof Error ? [k, { message: v.message, stack: v.stack }] : [k, v],
    ),
  );
}

const hotReloadLog: Logger = {
  info: (obj, msg) => writeHotReloadLog('info', obj, msg),
  warn: (obj, msg) => writeHotReloadLog('warn', obj, msg),
  error: (obj, msg) => writeHotReloadLog('error', obj, msg),
};

/**
 * Rows whose kind is in TRUSTED_KIND_PREFIXES (curated beliefs and knowledge,
 * captured sessions, corrections) come back unfenced. Everything else — integration
 * records, research briefs, behavioral signals, `remember` notes — can carry text a
 * third party wrote or a manipulated model stored, so read tools fence it. The same
 * registry reserves those kinds on the write tools.
 */
function isFirstPartyKind(kind: unknown): boolean {
  return typeof kind === 'string' && TRUSTED_KIND_PREFIXES.some((p) => kind.startsWith(p));
}

/**
 * Serialize read-tool rows, fencing the text fields of third-party rows. The note
 * leads only when something was fenced, so first-party-only results cost nothing.
 */
export function renderMemoryRows(rows: unknown[], fields: readonly string[]): string {
  let fenced = false;
  const out = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const r = row as Record<string, unknown>;
    if (isFirstPartyKind(r.kind)) return r;
    const copy: Record<string, unknown> = { ...r };
    for (const f of fields) {
      if (typeof copy[f] === 'string' && copy[f]) {
        copy[f] = wrapUntrusted(copy[f] as string, {
          source: String(r.kind ?? 'unknown'),
          trust: 'untrusted',
        });
        fenced = true;
      }
    }
    return copy;
  });
  const json = JSON.stringify(out, null, 2);
  return fenced ? `${UNTRUSTED_NOTE}\n${json}` : json;
}

/**
 * Memory-ledger writes refuse credential shapes before anything persists. A
 * stored key is auto-recalled into later sessions and sent to the embedding
 * API; captured sessions are redacted instead (capture.ts), but a direct write
 * is a caller that can drop the secret and retry. Local and remote alike.
 */
const INBOUND_CHECKED: ReadonlySet<string> = new Set(REMOTE_WRITE_TOOLS);

function guardInbound(name: string, cb: ToolCb): ToolCb {
  if (!INBOUND_CHECKED.has(name)) return cb;
  return ((args: unknown, extra: unknown) => {
    const verdict = checkInboundArgs(args);
    if (!verdict.ok) return inboundRefusal(verdict.reason);
    return (cb as (a: unknown, e: unknown) => unknown)(args, extra);
  }) as ToolCb;
}

export function buildCoreServer(deps: CoreServerDeps, opts: CoreServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'robin-core', version: VERSION });

  // Registration goes through this gate rather than `server.registerTool` so a
  // tool added later is exposed remotely only by an explicit edit to the
  // allowlist. New tools default to local-only, which is the safe default.
  const allowed: ReadonlySet<string> | null = opts.allow ?? null;
  const readOnly = opts.readOnly === true;
  const reloadable = opts.reloadable !== false;

  // Only constructed when this instance actually owns `deps.db` (see
  // CoreServerOptions.reloadable) — a caller that opted out never pays for a
  // repoRoot resolution, a stamp read, or a `currentDb` handle it must never
  // close.
  let dispatch: ReloadableDispatch | null = null;
  if (reloadable) {
    const repoRoot = opts.repoRoot ?? defaultRepoRoot();
    // Tracks the DB handle backing the CURRENTLY active tool table, across
    // however many reload generations have happened — not just `deps.db`.
    // Each successful rebuild opens a new handle and must close the one from
    // the PREVIOUS generation, whichever generation that was.
    let currentDb: RobinDb = deps.db;

    dispatch = createReloadableDispatch({
      repoRoot,
      log: hotReloadLog,
      rebuild: async () => {
        // Read the stamp again here (checkAndReload already read it to decide
        // "stale") rather than threading it through: the contract for `rebuild`
        // takes no arguments, and a stamp that moved again in the interim just
        // means the NEXT checkAndReload call will see it and try again.
        const stamp = readBuildStamp(repoRoot);
        const sha = stamp?.sha ?? 'unknown';
        // Deep-tree coherence guard (task-4 review finding 2, boundary fixed
        // in a follow-up review round): the self-import below only refreshes
        // THIS module's own compiled file — everything it statically imports
        // resolves through unbusted specifiers and stays on whatever this
        // process cached at start. That's not just belief.ts/recall.ts/etc.:
        // it's ALSO this file's sibling MCP imports, skill-tool.ts (real
        // per-call business logic — see the `skill` tool below) and
        // hot-reload.ts itself. The deep hash's exclusion set
        // (SELF_IMPORTED_FILES in system/scripts/deep-hash.mjs) reflects
        // exactly that: it excludes ONLY server.js/server.d.ts, not the whole
        // surfaces/mcp/** subtree, specifically so a change to skill-tool.ts
        // or hot-reload.ts still moves the deep hash and trips this guard. If
        // the deep tree changed (a differing deep hash), the fresh top-level
        // glue below could silently pair with those still-cached deep
        // modules and mix code generations — e.g. new glue passing a renamed
        // options key to an old, still-cached function that doesn't know
        // about it. Refuse before importing anything rather than risk that;
        // `assertDeepHashCoherent` no-ops when either side has no deep hash
        // to compare (2-line legacy stamp, or nothing hashable).
        assertDeepHashCoherent(LOADED_DEEP_HASH, stamp?.deepHash ?? null);
        // Cache-busted self-import: appending a query string is a distinct
        // module specifier, so Node re-reads and re-executes this file from
        // disk instead of returning the module instance already cached from
        // process start. Only THIS module's own top-level code is refreshed:
        // its inline tool-callback LOGIC (SQL, readOnly branches, business
        // logic inside each tool body) and `buildCoreDeps`. Tool SCHEMAS and
        // REGISTRATION are not refreshed by this at all — `server.registerTool`
        // runs exactly once, at the original `buildCoreServer` call, and a
        // reload only ever swaps which function a name dispatches to. A
        // schema/description change, same as a deep-module change, still
        // needs a process restart.
        const mod = (await import(`${import.meta.url}?v=${sha}`)) as ServerModule;
        const freshDeps = mod.buildCoreDeps();
        const freshCallbacks = mod.buildToolCallbacks({
          db: freshDeps.db,
          llm: freshDeps.llm,
          readOnly,
        });
        const table = new Map<string, ToolCb>();
        for (const [name, entry] of freshCallbacks) table.set(name, entry.cb);
        // Only close the OLD db handle once the new table has been built
        // successfully in full — closing any earlier would leave the
        // currently-registered callbacks (still pointing at the old table
        // until this function returns) holding a dead connection if anything
        // above had thrown.
        closeDb(currentDb);
        currentDb = freshDeps.db;
        return table;
      },
    });
  }

  function register(name: string, config: ToolConfig, cb: ToolCb): void {
    if (allowed && !allowed.has(name)) return;
    // Guard outside the reload wrapper so a hot-swapped callback can't skip it.
    server.registerTool(name, config, guardInbound(name, dispatch ? dispatch.wrap(name, cb) : cb));
  }

  const initial = buildToolCallbacks({ db: deps.db, llm: deps.llm, readOnly });
  for (const [name, entry] of initial) {
    register(name, entry.config, entry.cb);
  }

  return server;
}

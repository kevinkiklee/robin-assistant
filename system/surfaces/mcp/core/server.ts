import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { buildDispatcherFromConfig } from '../../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import { believe, normalizeTopic, recallBelief } from '../../../brain/memory/belief.ts';
import {
  countPendingCandidates,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from '../../../brain/memory/belief-candidate.ts';
import { openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { findEntity, getEntity, upsertEntity } from '../../../brain/memory/entity.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { recall } from '../../../brain/memory/recall.ts';
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
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';
import { loadEnvFile } from '../../../lib/secrets/load-env.ts';
import { VERSION } from '../../../lib/version.ts';
import { defaultSkillRoots } from '../../../skills/_runtime/loader.ts';
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
    llm = buildDispatcherFromConfig(models, { lenient: true });
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

export function buildCoreServer(deps: CoreServerDeps): McpServer {
  const server = new McpServer({ name: 'robin-core', version: VERSION });

  server.registerTool(
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
      const hits = await recall(deps.db, deps.llm, query, { limit, mode });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
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
      const r = ingest(deps.db, deps.llm, {
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

  server.registerTool(
    'find_entity',
    {
      description: 'Search entities by name (partial match).',
      inputSchema: z.object({
        query: z.string().describe('Name to search'),
        type: z.string().optional().describe('Filter by entity type'),
      }),
    },
    async ({ query, type }) => {
      const hits = findEntity(deps.db, query, type);
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.registerTool(
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
        const e = getEntity(deps.db, id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(e) }] };
      }
      if (key) {
        const e = upsertEntity(deps.db, type, key);
        return { content: [{ type: 'text' as const, text: JSON.stringify(e) }] };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'must provide id or key' }) },
        ],
      };
    },
  );

  server.registerTool(
    'list',
    {
      description:
        "Generic lister for entities, events, jobs, predictions, corrections. For events, supports optional `kind` and `since` filters so callers can pull e.g. the last 3 `v2.whoop` ticks or today's `v2.lunch_money` transactions.",
      inputSchema: z.object({
        type: z
          .enum(['entities', 'events', 'jobs', 'predictions', 'corrections'])
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
          rows = deps.db
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
            rows = deps.db
              .prepare(
                `SELECT events.id, events.ts, events.kind, events.source, events.status, events.payload, events_content.body
                 FROM events LEFT JOIN events_content ON events_content.id = events.content_ref
                 ${whereClause} ORDER BY events.ts DESC LIMIT ?`,
              )
              .all(...params) as unknown[];
          } else {
            params.push(lim);
            rows = deps.db
              .prepare(
                `SELECT id, ts, kind, source, status FROM events ${whereClause} ORDER BY events.ts DESC LIMIT ?`,
              )
              .all(...params) as unknown[];
          }
          break;
        }
        case 'jobs':
          rows = deps.db
            .prepare('SELECT * FROM jobs ORDER BY scheduled_at DESC LIMIT ?')
            .all(lim) as unknown[];
          break;
        case 'predictions':
          rows =
            (
              deps.db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'")
                .all() as unknown[]
            ).length > 0
              ? (deps.db
                  .prepare('SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?')
                  .all(lim) as unknown[])
              : [];
          break;
        case 'corrections':
          rows =
            (
              deps.db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'")
                .all() as unknown[]
            ).length > 0
              ? (deps.db
                  .prepare('SELECT * FROM corrections ORDER BY ts DESC LIMIT ?')
                  .all(lim) as unknown[])
              : [];
          break;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    'predict',
    {
      description:
        'Record a prediction with confidence and optional deadline. Used to track calibration over time.',
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
      }),
    },
    async ({ claim, confidence, deadline, resolution_method, external_id }) => {
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
      if (external_id) {
        const existing = deps.db
          .prepare('SELECT id FROM predictions WHERE external_id = ?')
          .get(external_id) as { id: number } | undefined;
        if (existing) {
          deps.db
            .prepare(
              'UPDATE predictions SET claim=?, confidence=?, deadline=?, resolution_method=? WHERE id=?',
            )
            .run(claim, confidence, deadline ?? null, resolution_method ?? null, existing.id);
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
      const info = deps.db
        .prepare(
          'INSERT INTO predictions (claim, confidence, deadline, resolution_method, external_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(claim, confidence, deadline ?? null, resolution_method ?? null, external_id ?? null);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ id: Number(info.lastInsertRowid) }) },
        ],
      };
    },
  );

  server.registerTool(
    'believe',
    {
      description:
        'Persist a topic-keyed belief-update. Auto-supersedes the prior belief for the topic; same-day repeats upsert in place. Topic is normalized (lowercase/dash). Use recall_belief to read current truth.',
      inputSchema: z.object({
        topic: z.string().describe('Dotted topic key, e.g. whoop.recovery.after_redeye_jfk'),
        claim: z.string().describe('The belief, in natural language'),
        supersedes: z.number().int().optional().describe('Override: event_id of the prior belief'),
        confidence: z.number().min(0).max(1).optional().describe('0..1, metadata only'),
        sources: z.array(z.number().int()).optional().describe("Today's event_ids that drove this"),
        retracted: z.boolean().optional().describe('True = no longer hold a belief here'),
      }),
    },
    async ({ topic, claim, supersedes, confidence, sources, retracted }) => {
      const r = believe(deps.db, deps.llm, {
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

  server.registerTool(
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
      const r = recallBelief(deps.db, { topic, history, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
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
      const candidates = listBeliefCandidates(deps.db, {
        status: status ?? 'pending',
        ...(limit !== undefined ? { limit } : {}),
      });
      const pending = countPendingCandidates(deps.db);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ pending, candidates }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
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
      const r = resolveBeliefCandidate(deps.db, deps.llm, id, action, reason);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }] };
    },
  );

  server.registerTool(
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
      const info = deps.db
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

  server.registerTool(
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
          rows = deps.db
            .prepare(
              `SELECT id, ts, kind, source, status FROM events WHERE ts > ? ORDER BY ts DESC LIMIT ?`,
            )
            .all(since, lim) as unknown[];
          break;
        case 'refusals':
          rows = deps.db
            .prepare(`SELECT * FROM refusals WHERE ts > ? ORDER BY ts DESC LIMIT ?`)
            .all(since, lim) as unknown[];
          break;
        case 'corrections':
          rows = deps.db
            .prepare(`SELECT * FROM corrections WHERE ts > ? ORDER BY ts DESC LIMIT ?`)
            .all(since, lim) as unknown[];
          break;
        case 'predictions':
          rows = deps.db
            .prepare(
              `SELECT * FROM predictions WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(since, lim) as unknown[];
          break;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
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

  server.registerTool(
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
        dbReachableInvariant(deps.db),
        dbSchemaCurrentInvariant(deps.db),
        dbWalSizeBoundedInvariant(deps.db),
        vecIndexSyncedInvariant(deps.db),
        schedulerProgressingInvariant(deps.db, { userData }),
      ]);
      return { content: [{ type: 'text' as const, text: JSON.stringify(reports, null, 2) }] };
    },
  );

  server.registerTool(
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
          content: [
            { type: 'text' as const, text: JSON.stringify(agentMetricsRows(deps.db), null, 2) },
          ],
        };
      }
      const w = window ?? '30d';
      const days = Math.min(Math.max(Number.parseInt(w, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
      let rows: unknown[] = [];
      if (kind) {
        rows = deps.db
          .prepare(`SELECT * FROM metrics_daily WHERE metric = ? AND day >= ? ORDER BY day DESC`)
          .all(kind, since) as unknown[];
      } else {
        rows = deps.db
          .prepare(
            `SELECT metric, day, value, n FROM metrics_daily WHERE day >= ? ORDER BY day DESC, metric`,
          )
          .all(since) as unknown[];
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    'journal',
    {
      description: 'Read the day journal — a narrative summary of what happened on a given day.',
      inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
      }),
    },
    async ({ date }) => {
      const day = date ?? new Date().toISOString().slice(0, 10);
      const row = deps.db
        .prepare(`SELECT body, generated_at FROM journals WHERE day = ?`)
        .get(day) as { body: string; generated_at: string } | undefined;
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

  server.registerTool(
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

  server.registerTool(
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
      const text =
        action === 'ack'
          ? id === undefined
            ? 'ack requires id'
            : runAck(deps.db, id)
          : listAlertsText(deps.db, { all });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // Skills — reusable methodologies (system + user). The tool description embeds
  // the catalog of valid skills (generated now, at server start) so Robin can see
  // what's available without a separate list call; `{ name }` loads one on demand.
  const skillRoots = defaultSkillRoots();
  server.registerTool(
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

  return server;
}

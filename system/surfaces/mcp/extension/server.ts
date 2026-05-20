import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runBiographer } from '../../../brain/cognition/biographer.ts';
import { runDream } from '../../../brain/cognition/dream.ts';
import { buildDispatcherFromConfig } from '../../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { openDb } from '../../../brain/memory/db.ts';
import { relatedEntities } from '../../../brain/memory/entity.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../../integrations/_runtime/context.ts';
import { actions as chromeActions } from '../../../integrations/builtin/chrome/index.ts';
import { actions as financeActions } from '../../../integrations/builtin/finance_quote/index.ts';
import { actions as githubActions } from '../../../integrations/builtin/github/index.ts';
// Static imports of integration action maps so type-checks catch breakage.
import { actions as gmailActions } from '../../../integrations/builtin/gmail/index.ts';
import { actions as gcalActions } from '../../../integrations/builtin/google_calendar/index.ts';
import { actions as linearActions } from '../../../integrations/builtin/linear/index.ts';
import { loadModels } from '../../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';

export interface ExtensionServerDeps {
  db: RobinDb;
  llm: LLMDispatcher | null;
}

export function buildExtensionDeps(): ExtensionServerDeps {
  const userData = resolveUserDataDir();
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

interface IntegrationActions {
  [action: string]: (
    params: Record<string, unknown>,
    ctx: ReturnType<typeof buildContext>,
  ) => Promise<unknown>;
}

function makeIntegrationTool(
  server: McpServer,
  deps: ExtensionServerDeps,
  name: string,
  actions: IntegrationActions,
  actionNames: string[],
  description: string,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        action: z
          .enum(actionNames as [string, ...string[]])
          .describe('Which integration action to run'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Parameters specific to the action'),
      },
    },
    async ({ action, params }) => {
      const fn = actions[action];
      if (!fn) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `unknown action '${action}' on ${name}` }),
            },
          ],
        };
      }
      const ctx = buildContext(name, deps.db, deps.llm);
      try {
        const out = await fn((params ?? {}) as Record<string, unknown>, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );
}

export function buildExtensionServer(deps: ExtensionServerDeps): McpServer {
  const server = new McpServer({ name: 'robin-extension', version: '3.0.0-alpha.0' });

  // Integration action-dispatchers
  makeIntegrationTool(
    server,
    deps,
    'gmail',
    gmailActions as unknown as IntegrationActions,
    ['search', 'get_thread', 'preview'],
    'Read Gmail: search, fetch threads, preview',
  );
  makeIntegrationTool(
    server,
    deps,
    'google_calendar',
    gcalActions as unknown as IntegrationActions,
    ['list_events', 'get_event'],
    'Read Google Calendar: list upcoming events, fetch event details',
  );
  makeIntegrationTool(
    server,
    deps,
    'github',
    githubActions as unknown as IntegrationActions,
    ['notifications', 'recent_activity'],
    'Read GitHub: unread notifications + recent activity',
  );
  makeIntegrationTool(
    server,
    deps,
    'linear',
    linearActions as unknown as IntegrationActions,
    ['active_issues', 'get_issue'],
    'Read Linear: active issues + per-issue lookup',
  );
  makeIntegrationTool(
    server,
    deps,
    'chrome',
    chromeActions as unknown as IntegrationActions,
    ['recent_visits'],
    'Read Chrome browsing history (local SQLite)',
  );
  makeIntegrationTool(
    server,
    deps,
    'finance',
    financeActions as unknown as IntegrationActions,
    ['quote_latest', 'history'],
    'Yahoo Finance quotes + history',
  );

  // Operational tools

  server.registerTool(
    'run',
    {
      description:
        'Run a cognition or integration job manually (biographer, dream, integration tick).',
      inputSchema: {
        type: z.enum(['biographer', 'dream', 'integration']).describe('Which job to run'),
        name: z.string().optional().describe('Integration name when type=integration'),
      },
    },
    async ({ type, name }) => {
      try {
        if (type === 'biographer') {
          const r = await runBiographer(deps.db, deps.llm);
          return { content: [{ type: 'text', text: JSON.stringify(r) }] };
        }
        if (type === 'dream') {
          const r = await runDream(deps.db, deps.llm);
          return { content: [{ type: 'text', text: JSON.stringify(r) }] };
        }
        if (type === 'integration') {
          if (!name)
            return {
              content: [
                { type: 'text', text: JSON.stringify({ error: 'integration name required' }) },
              ],
            };
          // Queue a manual job; the daemon will pick it up. For MVP, just report queued.
          deps.db
            .prepare(
              `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'manual', ?, 'pending')`,
            )
            .run(`integration.${name}.tick`, new Date().toISOString());
          return {
            content: [
              { type: 'text', text: JSON.stringify({ queued: `integration.${name}.tick` }) },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown type' }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'integration_status',
    {
      description: 'Per-integration health: last sync, error state, etc.',
      inputSchema: {
        name: z.string().optional().describe('Specific integration, or omit for all'),
      },
    },
    async ({ name }) => {
      const rows = name
        ? (deps.db
            .prepare(
              'SELECT integration_name, key, value, updated_at FROM integration_state WHERE integration_name = ?',
            )
            .all(name) as unknown[])
        : (deps.db
            .prepare('SELECT integration_name, key, value, updated_at FROM integration_state')
            .all() as unknown[]);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );

  server.registerTool(
    'ingest',
    {
      description:
        'Write a structured event into memory. Use this when a tool result should be remembered explicitly.',
      inputSchema: {
        kind: z.string(),
        source: z.string(),
        content: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ kind, source, content, payload }) => {
      const r = await ingest(deps.db, deps.llm, { kind, source, content, payload });
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    },
  );

  server.registerTool(
    'related_entities',
    {
      description: 'Graph traversal: entities connected to a given entity (1-hop default).',
      inputSchema: { entity_id: z.number().int(), hops: z.number().int().optional() },
    },
    async ({ entity_id, hops }) => {
      const r = relatedEntities(deps.db, entity_id, hops ?? 1);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.registerTool(
    'resolve_prediction',
    {
      description: 'Mark a prediction as resolved with an outcome.',
      inputSchema: {
        id: z.number().int(),
        outcome: z.enum(['right', 'wrong', 'unverifiable']),
        evidence: z.string().optional(),
      },
    },
    async ({ id, outcome, evidence }) => {
      // Fetch confidence to compute Brier delta
      const row = deps.db.prepare('SELECT confidence FROM predictions WHERE id = ?').get(id) as
        | { confidence: number }
        | undefined;
      if (!row)
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `prediction ${id} not found` }) },
          ],
        };
      const truth = outcome === 'right' ? 1 : outcome === 'wrong' ? 0 : null;
      const brierDelta = truth === null ? null : (row.confidence - truth) ** 2;
      deps.db
        .prepare(
          `UPDATE predictions SET outcome = ?, resolved_at = ?, evidence = ?, brier_delta = ? WHERE id = ?`,
        )
        .run(outcome, new Date().toISOString(), evidence ?? null, brierDelta, id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, outcome, brier_delta: brierDelta }) }],
      };
    },
  );

  server.registerTool(
    'check_action',
    {
      description: 'Pre-flight check for a risky action. Returns trust assessment.',
      inputSchema: {
        action: z.string().describe('Description of the action being considered'),
        params: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ action }) => {
      // MVP: simple stub. Real action-policy enforcement ships in a later plan.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action,
              trust: 'allow',
              note: 'check_action is a stub in MVP; no policy enforcement yet',
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'update',
    {
      description: 'Update a rule or policy by id with the given JSON patch.',
      inputSchema: {
        target: z.enum(['rule', 'policy']),
        id: z.union([z.number().int(), z.string()]),
        changes: z.record(z.string(), z.unknown()),
      },
    },
    async ({ target, id, changes }) => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              message: `${target} table not yet implemented; ${JSON.stringify({ id, changes })} would have been applied`,
            }),
          },
        ],
      };
    },
  );

  return server;
}

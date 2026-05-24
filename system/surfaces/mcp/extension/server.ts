import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
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
import { writeActions as linearWriteActions } from '../../../integrations/builtin/linear/write.ts';
import { loadModels } from '../../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';
import { runAgentAction } from './agent-action.ts';

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
  const allLinearActions = { ...linearActions, ...linearWriteActions };
  makeIntegrationTool(
    server,
    deps,
    'linear',
    allLinearActions as unknown as IntegrationActions,
    ['active_issues', 'get_issue', 'create_issue', 'update_issue', 'transition', 'comment'],
    'Linear: read issues + create/update/transition/comment',
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
      description:
        'Per-integration health: last sync, error state, status. With `name`, returns full per-key state for that integration. Without `name`, returns a compact one-row-per-integration summary (same shape as the `robin integrations` CLI) — earlier the no-arg path dumped every KV row including 200-item seen-sets and could exceed 7 MB.',
      inputSchema: {
        name: z.string().optional().describe('Specific integration, or omit for all'),
      },
    },
    async ({ name }) => {
      if (name) {
        // Per-integration full detail: caller asked explicitly, so they want everything.
        // Still cap value length so a runaway extension can't push megabytes.
        const rows = deps.db
          .prepare(
            'SELECT integration_name, key, substr(value, 1, 4096) AS value, updated_at FROM integration_state WHERE integration_name = ?',
          )
          .all(name) as unknown[];
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      }
      // All-integrations: compact summary via the shared report builder. One row per
      // integration with status + standardized health fields; no raw KV blobs.
      const { runIntegrationsReport } = await import('../../cli/integrations.ts');
      const report = runIntegrationsReport();
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
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

  server.registerTool(
    'agent',
    {
      description:
        'Run a guarded agentic task through runAgent. Only on-demand handlers are reachable here; autonomous handlers run via the detached runner. Handler I (life-executor) requires confirm:true for irreversible actions.',
      inputSchema: {
        handler: z.string().describe('Handler id, A..L (only on-demand handlers are allowed)'),
        goal: z.string().describe('The task prompt for the agent'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required true for handler I (life-executor) — confirms irreversible actions'),
      },
    },
    async ({ handler, goal, confirm }) => {
      const out = await runAgentAction(
        { handler, goal, ...(confirm !== undefined ? { confirm } : {}) },
        { db: deps.db },
      );
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );

  registerUserExtensionActions(server, deps);
  return server;
}

/**
 * Discover user-data extensions that export an `actions` map and register each
 * as an MCP tool. Lets user-authored integrations (e.g. spotify_write) expose
 * callable actions to Claude without statically importing from the gitignored
 * user-data tree. Safe on fresh installs: silently no-ops when the dir doesn't
 * exist or no extensions export actions.
 */
function registerUserExtensionActions(server: McpServer, deps: ExtensionServerDeps): void {
  const userDataRoot = resolveUserDataDir();
  const integrationsRoot = join(userDataRoot, 'extensions', 'integrations');
  if (!existsSync(integrationsRoot)) return;

  const compiled = import.meta.url.endsWith('.js');

  for (const entry of readdirSync(integrationsRoot)) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const dir = join(integrationsRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const ts = join(dir, 'index.ts');
    const js = join(dir, 'index.js');
    const entryFile = compiled
      ? existsSync(js)
        ? js
        : existsSync(ts)
          ? ts
          : null
      : existsSync(ts)
        ? ts
        : existsSync(js)
          ? js
          : null;
    if (!entryFile) continue;

    // Fire-and-forget — server is sync, dynamic import is async. The MCP server
    // returns to the client immediately; user-extension tools register a tick
    // or two later. Acceptable for boot-time discovery.
    void (async () => {
      try {
        const url = `file://${resolvePath(entryFile)}`;
        const mod = (await import(url)) as { actions?: Record<string, unknown> };
        const actions = mod.actions;
        if (!actions || typeof actions !== 'object') return;
        const names = Object.keys(actions).filter((k) => typeof actions[k] === 'function');
        if (names.length === 0) return;
        makeIntegrationTool(
          server,
          deps,
          entry,
          actions as unknown as IntegrationActions,
          names,
          `User-extension ${entry}: ${names.join(', ')}`,
        );
      } catch {
        // best-effort — fail silently on broken extensions
      }
    })();
  }
}

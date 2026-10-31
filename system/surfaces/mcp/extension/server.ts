import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UsageLedger } from '../../../agent/usage-ledger.ts';
import { runBiographer } from '../../../brain/cognition/biographer.ts';
import { runDream } from '../../../brain/cognition/dream.ts';
import {
  getRecommendation,
  resolveRecommendation,
} from '../../../brain/cognition/recommendations/index.ts';
import { buildDispatcherFromConfig } from '../../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { openDb } from '../../../brain/memory/db.ts';
import { relatedEntities, withFreshProfile } from '../../../brain/memory/entity.ts';
import { ingest } from '../../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../../integrations/_runtime/context.ts';
import { loadIntegrations } from '../../../integrations/_runtime/loader.ts';
import { actions as discordActions } from '../../../integrations/builtin/discord/index.ts';
import { actions as financeActions } from '../../../integrations/builtin/finance_quote/index.ts';
// Static imports of integration action maps so type-checks catch breakage.
import { actions as gmailActions } from '../../../integrations/builtin/gmail/index.ts';
import { actions as gcalActions } from '../../../integrations/builtin/google_calendar/index.ts';
import { actions as linearActions } from '../../../integrations/builtin/linear/index.ts';
import { writeActions as linearWriteActions } from '../../../integrations/builtin/linear/write.ts';
import { loadModels } from '../../../kernel/config/load.ts';
import { LOADED_DEEP_HASH, LOADED_SHA, readBuildStamp } from '../../../lib/build-stamp.ts';
import {
  checkInboundArgs,
  inboundRefusal,
  reservedKindRefusal,
  reservedMemoryKind,
} from '../../../lib/discretion/policy.ts';
import { UNTRUSTED_NOTE, wrapUntrusted } from '../../../lib/discretion/wrap-untrusted.ts';
import { dbFilePath, resolveUserDataDir } from '../../../lib/paths.ts';
import { loadEnvFile } from '../../../lib/secrets/load-env.ts';
import { VERSION } from '../../../lib/version.ts';
import { stalenessNotice, wrapRegistrarWithStalenessNotice } from '../staleness-notice.ts';
import { runAgentAction } from './agent-action.ts';
import { type IntegrationStateRow, redactIntegrationStateRows } from './redact.ts';

export interface ExtensionServerDeps {
  db: RobinDb;
  llm: LLMDispatcher | null;
}

export function buildExtensionDeps(): ExtensionServerDeps {
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

interface IntegrationActions {
  [action: string]: (
    params: Record<string, unknown>,
    ctx: ReturnType<typeof buildContext>,
  ) => Promise<unknown>;
}

/**
 * Integration results are fenced as untrusted by default: email, calendar invites,
 * fetched pages, Linear comments from teammates, birding-checklist notes — most
 * carry text someone else wrote, so an agent reading them can't be steered by it.
 * Only results with no third-party free text are exempt. A new or user extension
 * is fenced unless added here.
 */
const FIRST_PARTY_RESULT_INTEGRATIONS: ReadonlySet<string> = new Set([
  'finance', // market quotes
  'discord', // send receipts for Robin's own posts
]);

export function renderActionResult(integration: string, action: string, out: unknown): string {
  const json = JSON.stringify(out, null, 2);
  if (FIRST_PARTY_RESULT_INTEGRATIONS.has(integration)) return json;
  return `${UNTRUSTED_NOTE}\n${wrapUntrusted(json, { source: `${integration}.${action}`, trust: 'untrusted' })}`;
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
        return { content: [{ type: 'text', text: renderActionResult(name, action, out) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              // Error text can echo a fetched page or API body — same fence as results.
              text: renderActionResult(name, action, {
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    },
  );
}

/**
 * Package root, four levels up from this file whether it runs from source
 * (system/surfaces/mcp/extension/) or compiled (dist/surfaces/mcp/extension/)
 * — same depth and same reasoning as `defaultRepoRoot()` in core/server.ts.
 * Never `process.cwd()`: an MCP server is launched from the client's working
 * directory, not the package's.
 */
function defaultRepoRoot(): string {
  return resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export function buildExtensionServer(deps: ExtensionServerDeps): McpServer {
  const server = new McpServer({ name: 'robin-extension', version: VERSION });

  // Unlike the core server, this one cannot REFUSE when it goes stale — it
  // holds the tools that act (`run`, `agent`, `discord`, linear writes), and
  // one `pnpm build` would otherwise disarm every open session at once. So it
  // warns on each result instead. Applied before any registerTool call below
  // so every tool is covered, including the user-data extension tools that
  // register asynchronously after this function returns.
  const repoRoot = defaultRepoRoot();
  const loadedStamp = { sha: LOADED_SHA, deepHash: LOADED_DEEP_HASH };
  wrapRegistrarWithStalenessNotice(server, () => {
    const current = readBuildStamp(repoRoot);
    return stalenessNotice(loadedStamp, {
      sha: current?.sha ?? null,
      deepHash: current?.deepHash ?? null,
    });
  });

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
    'finance',
    financeActions as unknown as IntegrationActions,
    ['quote_latest', 'history'],
    'Yahoo Finance quotes + history',
  );
  makeIntegrationTool(
    server,
    deps,
    'discord',
    discordActions as unknown as IntegrationActions,
    ['notify', 'dm', 'digest'],
    "Ping the operator on Discord: 'notify' posts to the alerts channel (mentions the operator by default), 'dm' sends a direct message, 'digest' posts a long document as consecutive chunked messages in the channel (never a thread). Pass silent:true to deliver without a push notification. Use for things worth interrupting them for, not routine output.",
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
          const userData = resolveUserDataDir();
          const builtinRoot = join(
            resolvePath(import.meta.dirname ?? '.'),
            '..',
            '..',
            '..',
            'integrations',
            'builtin',
          );
          const userRoot = join(userData, 'extensions/integrations');
          const loaded = await loadIntegrations([builtinRoot, userRoot]);
          const match = loaded.find((i) => i.instanceName === name || i.manifest.name === name);
          if (!match)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `integration '${name}' not found` }),
                },
              ],
            };
          if (!match.module.tick)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `integration '${name}' has no tick()` }),
                },
              ],
            };
          const ctx = buildContext(match.instanceName, deps.db, deps.llm);
          const r = await match.module.tick(ctx);
          return { content: [{ type: 'text', text: JSON.stringify(r) }] };
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
          .all(name) as IntegrationStateRow[];
        // OAuth access/refresh tokens live in this table; the key, integration
        // and updated_at are the diagnostics, the value never is.
        const safe = redactIntegrationStateRows(rows);
        return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }] };
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
      // Same rule as robin-core's memory writes: a stored key gets recalled and embedded.
      if (reservedMemoryKind(kind)) return reservedKindRefusal(kind);
      const verdict = checkInboundArgs({ kind, source, content, payload });
      if (!verdict.ok) return inboundRefusal(verdict.reason);
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
      const r = relatedEntities(deps.db, entity_id, hops ?? 1).map((e) =>
        withFreshProfile(deps.db, e),
      );
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
    'resolve_recommendation',
    {
      description:
        "Manually resolve a recommendation the linker can't infer: outcome='acted' (the operator acted on it — e.g. a purchase with no tracked transaction) or 'declined' (the operator explicitly declined). Mirrors resolve_prediction. Resolving a missing recommendation errors.",
      inputSchema: {
        id: z.number().int(),
        outcome: z.enum(['acted', 'declined']),
        evidence: z.string().optional(),
      },
    },
    async ({ id, outcome, evidence }) => {
      const existing = getRecommendation(deps.db, id);
      if (!existing)
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: `recommendation ${id} not found` }) },
          ],
        };
      // 'acted' → status=acted/outcome=acted (with acted_at now); 'declined' →
      // status=declined/outcome=not_acted. Manual resolves carry no action_event_id.
      const acted = outcome === 'acted';
      resolveRecommendation(deps.db, id, {
        status: acted ? 'acted' : 'declined',
        outcome: acted ? 'acted' : 'not_acted',
        actedAt: acted ? new Date() : undefined,
        evidence: evidence ?? `manual resolve: ${outcome}`,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, outcome }) }],
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

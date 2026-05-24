import { loadPolicies } from '../../../kernel/config/load.ts';
import type { Policies } from '../../../kernel/config/schema.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';
import type { IntegrationContext } from '../../_runtime/types.ts';
import { isSatisfied, lookupByRef } from './map.ts';
import { writeActions } from './write.ts';

/* ---------- types ---------- */

type LinearConfig = Policies['linear'];

interface Signal {
  robin_ref: string;
  team: string;
  title: string;
  description: string;
  source_event_id?: number;
}

interface LoopResult {
  proposed: number;
  created: number;
  skipped: number;
}

/* ---------- config ---------- */

function loadLinearConfig(): LinearConfig {
  return loadPolicies(resolveUserDataDir()).linear;
}

/* ---------- signal detection ---------- */

function sanitizeForRef(raw: string): string {
  return raw
    .slice(0, 100)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function detectIntegrationErrors(ctx: IntegrationContext, config: LinearConfig): Signal[] {
  const signals: Signal[] = [];

  // Find integrations with >= 3 consecutive errors
  const rows = ctx.db
    .prepare(
      `SELECT integration_name, value FROM integration_state
       WHERE key = 'consecutive_errors' AND CAST(value AS INTEGER) >= 3`,
    )
    .all() as Array<{ integration_name: string; value: string }>;

  for (const row of rows) {
    const integrationName = row.integration_name;

    // Look up team mapping
    const team = config.integration_team_map[integrationName];
    if (!team) continue;

    // Must be a writable team
    if (!config.writable_teams.includes(team)) continue;

    // Fetch last_error for this integration
    const errorRow = ctx.db
      .prepare(
        `SELECT value FROM integration_state
         WHERE integration_name = ? AND key = 'last_error'`,
      )
      .get(integrationName) as { value: string } | undefined;

    const lastError = errorRow?.value ?? 'unknown error';
    const errorHash = sanitizeForRef(lastError);
    const robinRef = `integration-error:${integrationName}:${errorHash}`;
    const errorCount = parseInt(row.value, 10);

    signals.push({
      robin_ref: robinRef,
      team,
      title: `[auto] ${integrationName} integration failing (${errorCount} consecutive errors)`,
      description: [
        `The **${integrationName}** integration has failed ${errorCount} consecutive times.`,
        '',
        '**Last error:**',
        '```',
        lastError,
        '```',
        '',
        '_This issue was created automatically by Robin._',
      ].join('\n'),
    });
  }

  return signals;
}

/* ---------- rate limiter ---------- */

function pruneAndCheckDaily(
  ctx: IntegrationContext,
  limit: number,
): { allowed: boolean; timestamps: number[] } {
  const raw = ctx.state.get('autonomous_creates');
  let timestamps: number[] = raw ? (JSON.parse(raw) as number[]) : [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  timestamps = timestamps.filter((t) => t > cutoff);
  return { allowed: timestamps.length < limit, timestamps };
}

function recordCreate(ctx: IntegrationContext, timestamps: number[]): void {
  timestamps.push(Date.now());
  ctx.state.set('autonomous_creates', JSON.stringify(timestamps));
}

/* ---------- main loop ---------- */

export async function runAutonomousLoop(ctx: IntegrationContext): Promise<LoopResult> {
  const zeros: LoopResult = { proposed: 0, created: 0, skipped: 0 };

  const config = loadLinearConfig();

  if (!config.autonomous_enabled) return zeros;

  // Power gate: skip if not active
  const policies = loadPolicies(resolveUserDataDir());
  if (policies.power.state !== 'active') return zeros;

  // Circuit-breaker: skip if auth failed
  if (ctx.state.get('auth_failed') === 'true') return zeros;

  // Detect signals
  const signals = detectIntegrationErrors(ctx, config);

  let proposed = 0;
  let created = 0;
  let skipped = 0;
  let tickCreates = 0;

  for (const signal of signals) {
    // Per-tick rate limit
    if (tickCreates >= config.rate_limit.per_tick) break;

    // Daily rate limit
    const { allowed, timestamps } = pruneAndCheckDaily(ctx, config.rate_limit.per_day);
    if (!allowed) {
      skipped++;
      continue;
    }

    // Idempotency: already satisfied (completed/cancelled)
    if (isSatisfied(ctx.db, signal.robin_ref)) {
      skipped++;
      continue;
    }

    // Idempotency: already filed (open)
    if (lookupByRef(ctx.db, signal.robin_ref)) {
      skipped++;
      continue;
    }

    proposed++;

    // Dry-run: emit proposed event but don't create
    if (config.dry_run) {
      tickCreates++;
      await ctx.ingest({
        kind: 'linear.write.proposed',
        source: 'linear',
        content: `[dry-run] Would create: ${signal.title}`,
        payload: {
          action: 'create_issue_proposed',
          robin_ref: signal.robin_ref,
          team: signal.team,
          title: signal.title,
          autonomous: true,
        },
      });
      continue;
    }

    // Create the issue
    try {
      const result = await writeActions.create_issue(
        {
          team: signal.team,
          title: signal.title,
          description: signal.description,
          robin_ref: signal.robin_ref,
          source_event_id: signal.source_event_id,
          autonomous: true,
        },
        ctx,
      );

      if (result.created) {
        created++;
        tickCreates++;
        recordCreate(ctx, timestamps);
      } else {
        skipped++;
      }
    } catch (err: unknown) {
      // Circuit-breaker on auth failures
      const message = err instanceof Error ? err.message : String(err);
      if (/\b40[13]\b/.test(message)) {
        ctx.state.set('auth_failed', 'true');
        break;
      }
      ctx.log.warn({ err: message, robin_ref: signal.robin_ref }, 'autonomous create failed');
    }
  }

  return { proposed, created, skipped };
}

import { join } from 'node:path';
import { REGISTRY } from '../../../agent/handlers/index.ts';
import { type RunAgentInput, type RunAgentResult, runAgent } from '../../../agent/run-agent.ts';
import { UsageLedger } from '../../../agent/usage-ledger.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { loadPolicies } from '../../../kernel/config/load.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';

export interface AgentActionParams {
  handler: string;
  goal: string;
  /** Required `true` for handler I (life-executor) — irreversible life actions. */
  confirm?: boolean;
}

export interface AgentActionDeps {
  db: RobinDb;
  runAgent?: typeof runAgent;
  userDataDir?: string;
  repoRoot?: string;
}

export type AgentActionResult =
  | { error: string }
  | {
      status: RunAgentResult['status'];
      summary: string;
      turns: number;
      costUsd: number;
    };

/**
 * MCP `agent` action core. Mirrors the integration-action dispatch but funnels
 * through the same guarded `runAgent` path the CLI uses. Constraints (spec §8/§11):
 *  - only `trigger: 'on-demand'` handlers are reachable here (autonomous ones run
 *    via the detached runner, never a chat-triggered MCP call);
 *  - handler I (life-executor) requires an explicit `{ confirm: true }` because
 *    its irreversible life actions (bookings, sends, payments) must be confirmed.
 *
 * Write handlers are NOT given a worktree here — worktree isolation is a watched
 * CLI concern; the MCP surface exposes the on-demand read/integration handlers.
 */
export async function runAgentAction(
  params: AgentActionParams,
  deps: AgentActionDeps,
): Promise<AgentActionResult> {
  const handler = (params.handler ?? '').toUpperCase();
  const def = REGISTRY[handler];
  if (!def) {
    return {
      error: `unknown handler '${params.handler}' (known: ${Object.keys(REGISTRY).sort().join(', ')})`,
    };
  }

  // Only on-demand handlers are reachable from MCP; autonomous run via the runner.
  if (def.trigger !== 'on-demand') {
    return {
      error: `handler ${def.id} (${def.name}) is autonomous — it runs via the detached runner, not the agent MCP action`,
    };
  }

  // Handler I is the hard risk gate: confirm irreversible life actions (spec §11).
  if (def.id === 'I' && params.confirm !== true) {
    return {
      error:
        'handler I (life-executor) takes irreversible actions — pass { confirm: true } to proceed',
    };
  }

  const userDataDir = deps.userDataDir ?? resolveUserDataDir();
  const repoRoot = deps.repoRoot ?? process.cwd();
  const run = deps.runAgent ?? runAgent;

  const built = def.build(params.goal, { repoRoot });
  const input: RunAgentInput = { ...built, surface: 'agentic-on-demand' };

  const cap = loadPolicies(userDataDir).agent.caps.agentic_on_demand_daily_usd;
  const ledger = new UsageLedger(deps.db);
  const result = await run(input, {
    ledger,
    cap,
    transcriptDir: join(userDataDir, 'agent-runs'),
  });

  return {
    status: result.status,
    summary: result.summary,
    turns: result.turns,
    costUsd: result.costUsd,
  };
}

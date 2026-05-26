import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type RunSdkInput, runSdk as realRunSdk, type SdkResult } from './sdk.ts';
import type { UsageLedger } from './usage-ledger.ts';

export type AgentSurface = 'agentic-on-demand' | 'agentic-autonomous';

export interface RunAgentInput {
  surface: AgentSurface;
  goal: string;
  cwd: string;
  allowedTools: string[];
  /** Tools to deny even if otherwise available. `allowedTools` does not gate
   * builtins (Read/Write/Edit/Bash), so a read-only run passes the write builtins
   * here (e.g. `['Write','Edit','MultiEdit','NotebookEdit','Bash','KillBash']`). */
  disallowedTools?: string[];
  permissionMode: 'plan' | 'default' | 'acceptEdits';
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  mcpServers?: Record<string, unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool callback type is internal to the SDK
  canUseTool?: any;
  loadProjectSettings?: boolean;
  enableFileCheckpointing?: boolean;
  model?: string;
  /** SDK structured-output schema (`{ type:'json_schema', schema }`); result lands in `structured`. */
  outputFormat?: unknown;
  /** SDK sandbox settings — OS-level isolation that confines Bash + file writes (write handlers). */
  sandbox?: unknown;
}

export type RunAgentStatus = 'success' | 'capped' | 'denied' | 'timeout' | 'error';

export interface RunAgentResult {
  status: RunAgentStatus;
  summary: string;
  /** Parsed structured output when an `outputFormat` schema was requested (else undefined). */
  structured?: unknown;
  turns: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  costUsd: number;
  transcriptPath?: string;
}

export interface RunAgentDeps {
  ledger: UsageLedger;
  runSdk?: typeof realRunSdk;
  now?: () => Date;
  /** Directory where per-run JSONL transcripts are written. */
  transcriptDir?: string;
  /** Per-surface daily USD cap, checked pre-flight against the ledger. */
  cap: number;
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/** Map the SDK's terminal status onto the agent-run status vocabulary. */
function mapSdkStatus(status: SdkResult['status']): RunAgentStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'max_turns':
    case 'max_budget':
      return 'capped';
    default:
      return 'error';
  }
}

/**
 * Guarded agentic-execution primitive. Reuses the shared SDK wrapper, enforcing:
 *  - a pre-flight per-surface daily cap (skips the SDK entirely when already over),
 *  - a hard deadline via an AbortController firing at `timeoutMs`,
 *  - a JSONL transcript streamed from the SDK message hook,
 *  - exactly one usage-ledger row per run.
 *
 * It NEVER throws on cap/timeout/deny/error — every terminal condition is returned
 * as a `RunAgentResult.status` so callers (handlers, surfaces) can branch cleanly.
 */
export async function runAgent(input: RunAgentInput, deps: RunAgentDeps): Promise<RunAgentResult> {
  const now = deps.now ?? (() => new Date());
  const sdk = deps.runSdk ?? realRunSdk;

  // (a) Pre-flight cap — never spend a dollar past the surface's daily ceiling.
  if (deps.ledger.overCap(input.surface, deps.cap)) {
    return { status: 'capped', summary: '', turns: 0, usage: { ...EMPTY_USAGE }, costUsd: 0 };
  }

  // (b) Deadline. The shared wrapper accepts a plain AbortSignal; we own the timer.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('runAgent timeout')),
    input.timeoutMs,
  );
  // Don't keep the event loop alive solely for the deadline.
  if (typeof deadline.unref === 'function') deadline.unref();

  // Transcript: one JSONL line per streamed SDK message.
  let transcriptPath: string | undefined;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  if (deps.transcriptDir) {
    mkdirSync(deps.transcriptDir, { recursive: true });
    const ts = now().toISOString().replace(/[:.]/g, '-');
    transcriptPath = join(deps.transcriptDir, `${ts}-${input.surface}.jsonl`);
    stream = createWriteStream(transcriptPath, { flags: 'a' });
    // Prevent unhandled 'error' events (disk full, permission denied) from crashing
    // the daemon. A failed transcript is non-fatal — the agent run should continue.
    stream.on('error', () => {
      stream = undefined;
    });
  }
  const onMessage = (m: unknown) => {
    stream?.write(`${JSON.stringify(m)}\n`);
  };

  const sdkInput: RunSdkInput = {
    prompt: input.goal,
    cwd: input.cwd,
    allowedTools: input.allowedTools,
    ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
    permissionMode: input.permissionMode,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    abortSignal: controller.signal,
    billToPool: true,
    onMessage,
    ...(input.model ? { model: input.model } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
    ...(input.loadProjectSettings ? { loadProjectSettings: true } : {}),
    ...(input.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
  };

  let result: SdkResult;
  let threw = false;
  try {
    result = await sdk(sdkInput);
  } catch (err) {
    threw = true;
    result = {
      status: 'error',
      text: err instanceof Error ? err.message : String(err),
      turns: 0,
      costUsd: 0,
      usage: { ...EMPTY_USAGE },
      raw: null,
    };
  } finally {
    clearTimeout(deadline);
    await closeStream(stream);
  }

  // (d) Status mapping. A fired deadline wins over whatever the SDK reported —
  // an aborted run is a timeout regardless of how the SDK surfaced the abort.
  const status: RunAgentStatus = controller.signal.aborted
    ? 'timeout'
    : mapSdkStatus(result.status);

  // (c) One ledger row per run. Record even on timeout/error so partial spend is tracked.
  deps.ledger.record({
    surface: input.surface,
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    turns: result.turns,
    status,
    subtype: threw ? 'threw' : undefined,
  });

  return {
    status,
    summary: result.text,
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    turns: result.turns,
    usage: result.usage,
    costUsd: result.costUsd,
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

function closeStream(stream?: ReturnType<typeof createWriteStream>): Promise<void> {
  if (!stream || stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('error', () => resolve()); // don't reject on close-time errors
    stream.end(resolve);
  });
}

import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';

export type SdkStatus = 'success' | 'max_turns' | 'max_budget' | 'error';

export interface SdkResult {
  status: SdkStatus;
  text: string;
  structured?: unknown; // result.structured_output when an outputFormat schema was requested
  turns: number;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  raw: unknown; // the result message, for transcript/audit
}

export interface RunSdkInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  /** Tools to deny even when otherwise available. `allowedTools` gates MCP tools
   * but NOT builtins (Read/Write/Edit/Bash), so this is the real lever for a
   * structurally read-only run (e.g. `['Write','Edit','Bash']`). */
  disallowedTools?: string[];
  permissionMode?: 'plan' | 'default' | 'acceptEdits';
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool callback type is internal to the SDK
  canUseTool?: any;
  enableFileCheckpointing?: boolean;
  loadProjectSettings?: boolean;
  outputFormat?: unknown; // { type: 'json_schema', schema } — structured-output roles
  sandbox?: unknown; // SDK SandboxSettings — OS-level command isolation, passed through verbatim
  abortSignal?: AbortSignal;
  // Auth hygiene
  billToPool?: boolean; // strip ANTHROPIC_API_KEY/CLAUDE_API_KEY from env
  baseEnv?: Record<string, string | undefined>;
  // Injection for tests (defaults to the real SDK query)
  // biome-ignore lint/suspicious/noExplicitAny: query() arg/message shapes vary; injection point for fakes
  queryFn?: (args: any) => AsyncIterable<any>;
  onMessage?: (m: unknown) => void; // transcript hook
}

const SUBTYPE_STATUS: Record<string, SdkStatus> = {
  success: 'success',
  error_max_turns: 'max_turns',
  error_max_budget_usd: 'max_budget',
  error_during_execution: 'error',
  error_max_structured_output_retries: 'error',
};

function buildEnv(input: RunSdkInput): Record<string, string> {
  const src = input.baseEnv ?? process.env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
  if (input.billToPool) {
    delete out.ANTHROPIC_API_KEY;
    delete out.CLAUDE_API_KEY;
  }
  return out;
}

/**
 * The SDK accepts a full `AbortController`, not a bare signal. Wrap the caller's
 * `abortSignal` in a controller that aborts in lockstep so callers keep passing a
 * plain `AbortSignal` (deadline timers, etc.) without owning the controller.
 */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

/** Shape accumulated partial usage into the `SdkResult.usage` form. */
function partialUsage(r: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) {
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    ...(r.cachedInputTokens ? { cachedInputTokens: r.cachedInputTokens } : {}),
  };
}

export async function runSdk(input: RunSdkInput): Promise<SdkResult> {
  const queryFn = input.queryFn ?? realQuery;
  const stream = queryFn({
    prompt: input.prompt,
    options: {
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      ...(input.mcpServers
        ? // biome-ignore lint/suspicious/noExplicitAny: the public input keeps mcpServers loosely typed; the SDK narrows it
          { mcpServers: input.mcpServers as Record<string, any> }
        : {}),
      ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
      ...(input.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
      ...(input.loadProjectSettings ? { settingSources: ['project'] } : {}),
      ...(input.outputFormat
        ? // biome-ignore lint/suspicious/noExplicitAny: outputFormat kept loosely typed at the public edge; SDK narrows it
          { outputFormat: input.outputFormat as any }
        : {}),
      ...(input.sandbox
        ? // biome-ignore lint/suspicious/noExplicitAny: sandbox kept loosely typed at the public edge; SDK narrows it
          { sandbox: input.sandbox as any }
        : {}),
      ...(input.abortSignal ? { abortController: abortControllerFor(input.abortSignal) } : {}),
      env: buildEnv(input),
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: result message shape is narrowed by hand below
  let result: any;
  // Per-turn usage accumulated from assistant messages. The authoritative totals
  // + cost ride on the final `result` message, but an abort (deadline) or a
  // mid-stream throw can stop iteration before it arrives — this fallback keeps
  // the ledger from zeroing partial spend.
  const running = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  try {
    for await (const m of stream) {
      input.onMessage?.(m);
      // biome-ignore lint/suspicious/noExplicitAny: message union is wide; we only key on `type`
      const msg = m as any;
      if (msg.type === 'result') {
        result = msg;
      } else if (msg.type === 'assistant' && msg.message?.usage) {
        running.inputTokens += msg.message.usage.input_tokens ?? 0;
        running.outputTokens += msg.message.usage.output_tokens ?? 0;
        running.cachedInputTokens += msg.message.usage.cache_read_input_tokens ?? 0;
      }
    }
  } catch (err) {
    // Abort or mid-stream failure. Prefer a `result` message if one already
    // arrived; otherwise surface accumulated partial usage instead of throwing
    // away the run's spend.
    if (!result) {
      return {
        status: 'error',
        text: err instanceof Error ? err.message : String(err),
        turns: 0,
        costUsd: 0,
        usage: partialUsage(running),
        raw: null,
      };
    }
  }
  if (!result) {
    return {
      status: 'error',
      text: '',
      turns: 0,
      costUsd: 0,
      usage: partialUsage(running),
      raw: null,
    };
  }
  return {
    status: SUBTYPE_STATUS[result.subtype] ?? 'error',
    text: result.result ?? '',
    structured: result.structured_output,
    turns: result.num_turns ?? 0,
    costUsd: result.total_cost_usd ?? 0,
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      cachedInputTokens: result.usage?.cache_read_input_tokens,
    },
    raw: result,
  };
}

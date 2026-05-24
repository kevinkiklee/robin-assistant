import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';

export type SdkStatus = 'success' | 'max_turns' | 'max_budget' | 'error';

export interface SdkResult {
  status: SdkStatus;
  text: string;
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
  permissionMode?: 'plan' | 'default' | 'acceptEdits';
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK canUseTool callback type is internal to the SDK
  canUseTool?: any;
  enableFileCheckpointing?: boolean;
  loadProjectSettings?: boolean;
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
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
      ...(input.enableFileCheckpointing ? { enableFileCheckpointing: true } : {}),
      ...(input.loadProjectSettings ? { settingSources: ['project'] } : {}),
      ...(input.abortSignal ? { abortController: { signal: input.abortSignal } } : {}),
      env: buildEnv(input),
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: result message shape is narrowed by hand below
  let result: any;
  for await (const m of stream) {
    input.onMessage?.(m);
    // biome-ignore lint/suspicious/noExplicitAny: message union is wide; we only key on `type`
    if ((m as any).type === 'result') result = m;
  }
  if (!result) {
    return {
      status: 'error',
      text: '',
      turns: 0,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      raw: null,
    };
  }
  return {
    status: SUBTYPE_STATUS[result.subtype] ?? 'error',
    text: result.result ?? '',
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

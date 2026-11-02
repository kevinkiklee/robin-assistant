import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import { estimateCostUsd } from './pricing.ts';

export type SdkStatus = 'success' | 'max_turns' | 'max_budget' | 'error';

export interface SdkResult {
  status: SdkStatus;
  text: string;
  structured?: unknown; // result.structured_output when an outputFormat schema was requested
  turns: number;
  costUsd: number;
  /**
   * True when no `result` message arrived (abort/deadline, mid-stream throw) and
   * `costUsd`/`usage`/`turns` are a list-price estimate rebuilt from the streamed
   * assistant messages rather than the SDK's authoritative totals.
   */
  costEstimated?: boolean;
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
  /** SDK reasoning effort (`Options.effort`); unset = SDK default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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

/**
 * True when `text` is the SDK's usage-limit banner rather than model output
 * ("You've hit your weekly limit · resets Jun 15 at 7am (America/New_York)" —
 * observed live 2026-06-12 on both the Sonnet and weekly limits). Deliberately
 * tight: the banner is short and LEADS with the limit phrase, so long-form
 * prose that merely mentions limits never matches. Defined at the SDK layer so
 * the agentic path (run-agent) and the dispatcher provider (claude-agent)
 * share one definition.
 */
export function isSubscriptionLimitBanner(text: string): boolean {
  const t = text.trim();
  return t.length <= 200 && /^you['’]ve hit your\b.{0,60}?\blimit\b/i.test(t);
}

function buildEnv(input: RunSdkInput): Record<string, string> {
  const src = input.baseEnv ?? process.env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
  if (input.billToPool) {
    delete out.ANTHROPIC_API_KEY;
    delete out.CLAUDE_API_KEY;
  }
  // Mark the child as one of Robin's own LLM calls. Robin's Claude Code hooks
  // (session_end capture, session_start primer, user_prompt_submit recall) all
  // lead with a `[ -z "$ROBIN_INTERNAL_SDK" ] || exit 0` guard — without this
  // marker every internal call is captured back as a session.captured event
  // (a self-amplifying feedback loop: the biographer re-processes its own
  // prompts) and gets the primer injected into its context (token waste).
  out.ROBIN_INTERNAL_SDK = '1';
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

/** One API turn's usage as seen on the stream, keyed by `message.id`. */
interface StreamedTurn {
  model?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Characters of content (text, thinking, tool_use input) across the turn's blocks. */
  contentChars: number;
}

// Rough chars-per-token for output estimation when the streamed usage is stale.
const CHARS_PER_TOKEN = 4;

function contentChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { text?: unknown; thinking?: unknown; input?: unknown };
    if (typeof block.text === 'string') n += block.text.length;
    if (typeof block.thinking === 'string') n += block.thinking.length;
    if (block.input !== undefined) n += JSON.stringify(block.input)?.length ?? 0;
  }
  return n;
}

/**
 * Tally of streamed assistant messages, the fallback when no `result` arrives.
 *
 * Two SDK stream quirks (verified on a live agent-runs transcript, 2026-10-03):
 * every content block of one API turn is its own assistant message repeating
 * the SAME `message.id` and usage — so usage is deduped per id, not summed per
 * message — and that usage is the `message_start` snapshot, whose
 * `output_tokens` is a stub (8 streamed vs 3,920 final). Output is therefore
 * estimated as max(streamed output_tokens, content chars / 4).
 */
class StreamTally {
  private turnsById = new Map<string, StreamedTurn>();
  private anon = 0;

  add(message: {
    id?: unknown;
    model?: unknown;
    usage?: Record<string, unknown>;
    content?: unknown;
  }): void {
    const id = typeof message.id === 'string' ? message.id : `anon-${this.anon++}`;
    const u = message.usage ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const t = this.turnsById.get(id) ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      contentChars: 0,
    };
    if (typeof message.model === 'string') t.model = message.model;
    t.input = Math.max(t.input, num(u.input_tokens));
    t.cacheRead = Math.max(t.cacheRead, num(u.cache_read_input_tokens));
    t.cacheWrite = Math.max(t.cacheWrite, num(u.cache_creation_input_tokens));
    t.output = Math.max(t.output, num(u.output_tokens));
    t.contentChars += contentChars(message.content);
    this.turnsById.set(id, t);
  }

  private outputOf(t: StreamedTurn): number {
    return Math.max(t.output, Math.ceil(t.contentChars / CHARS_PER_TOKEN));
  }

  /** Best-known totals, shaped like the `SdkResult` usage/cost/turns fields. */
  snapshot(): Pick<SdkResult, 'usage' | 'costUsd' | 'turns'> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    for (const t of this.turnsById.values()) {
      const output = this.outputOf(t);
      inputTokens += t.input;
      outputTokens += output;
      cachedInputTokens += t.cacheRead;
      costUsd += estimateCostUsd(t.model, {
        inputTokens: t.input,
        outputTokens: output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
      });
    }
    return {
      usage: {
        inputTokens,
        outputTokens,
        ...(cachedInputTokens ? { cachedInputTokens } : {}),
      },
      costUsd,
      turns: this.turnsById.size,
    };
  }
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
      ...(input.effort ? { effort: input.effort } : {}),
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
      // Explicit even when empty: an omitted settingSources loads EVERY source,
      // so each internal call ran the user's SessionStart hooks and plugin fleet.
      // One of those hooks (ensure-running.sh) kickstarted the daemon whenever it
      // was slow to answer — the daily ~4am "crash" during dream-synthesis.
      settingSources: input.loadProjectSettings ? ['project'] : [],
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
  // the ledger from zeroing partial spend (it books a list-price estimate).
  const running = new StreamTally();
  try {
    for await (const m of stream) {
      input.onMessage?.(m);
      // biome-ignore lint/suspicious/noExplicitAny: message union is wide; we only key on `type`
      const msg = m as any;
      if (msg.type === 'result') {
        result = msg;
      } else if (msg.type === 'assistant' && msg.message) {
        running.add(msg.message);
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
        ...running.snapshot(),
        costEstimated: true,
        raw: null,
      };
    }
  }
  if (!result) {
    return {
      status: 'error',
      text: '',
      ...running.snapshot(),
      costEstimated: true,
      raw: null,
    };
  }
  // A usage-limited account comes back as a subtype:'success' result that
  // carries is_error:true (api_error_status 429) with the limit banner as its
  // text — observed live 2026-06-12, when the weekly-limit banner flowed
  // through three dream-synthesis specialists as "model output". Structured
  // output present is proof of a real completion and bypasses both checks.
  const mapped = SUBTYPE_STATUS[result.subtype] ?? 'error';
  const status =
    mapped === 'success' &&
    result.structured_output === undefined &&
    (result.is_error === true ||
      (typeof result.result === 'string' && isSubscriptionLimitBanner(result.result)))
      ? 'error'
      : mapped;
  return {
    status,
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

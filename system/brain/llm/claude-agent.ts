import { z } from 'zod';
import { type RunSdkInput, runSdk as realRunSdk, type SdkResult } from '../../agent/sdk.ts';
import type { UsageLedger } from '../../agent/usage-ledger.ts';
import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

/**
 * The provider passes JSON-schema structured-output through `runSdk` as
 * `outputFormat`. `RunSdkInput` doesn't model it (it forwards the option list
 * verbatim), so widen the injectable signature to carry the extra field.
 */
type RunSdkFn = (input: RunSdkInput & { outputFormat?: unknown }) => Promise<SdkResult>;

export interface ClaudeAgentProviderConfig {
  /** Cheap, pinned model. Downstream (build-dispatcher) sets it; default haiku. */
  model?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
  /** When provided, the REAL pool/subscription cost is recorded here (surface `provider`). */
  ledger?: UsageLedger;
  /** Injectable for tests; defaults to the real SDK wrapper. */
  runSdk?: RunSdkFn;
}

/**
 * Dispatcher provider backed by the Claude Agent SDK, billed to the prepaid pool /
 * subscription rather than a metered API key. It runs a single non-agentic turn with
 * no tools on a pinned cheap model.
 *
 * Cost accounting: the dispatcher sums `InvokeResult.costUsd` into its metered daily
 * cap. Prepaid pool dollars must NOT inflate that cap, so `invoke()` returns
 * `costUsd: 0`. The real cost is recorded to the `UsageLedger` (surface `provider`)
 * when a ledger is supplied.
 */
export class ClaudeAgentProvider implements LLMProvider {
  readonly name = 'claude-agent';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private model: string;
  private ledger?: UsageLedger;
  private runSdk: RunSdkFn;

  constructor(cfg: ClaudeAgentProviderConfig = {}) {
    this.model = cfg.model ?? 'claude-haiku-4-5';
    this.ledger = cfg.ledger;
    this.runSdk = cfg.runSdk ?? realRunSdk;
    this.capabilities = new Set(cfg.capabilities ?? ['summarize', 'classify']);
    // Pool-billed: report zero list price so the dispatcher's metered cap is unaffected.
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 200_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? 0,
      outputPricePerM: cfg.meta?.outputPricePerM ?? 0,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();

    // Flatten user/assistant turns into a single prompt — the SDK takes one prompt
    // string per query, and the system prompt is passed separately.
    const prompt = req.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
      .join('\n\n');

    const sdkInput: RunSdkInput & { outputFormat?: unknown } = {
      prompt,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      model: this.model,
      // Structured output consumes extra SDK turns after the answer turn;
      // maxTurns:1 cuts it off (status max_turns, no structured_output) and
      // even 2 is empirically insufficient on Fable 5. No tools are allowed
      // here, so the higher cap cannot cause an agentic loop.
      maxTurns: req.outputSchema ? 4 : 1,
      allowedTools: [],
      permissionMode: 'default',
      billToPool: true,
    };
    if (req.outputSchema) {
      // SDK contract is { type: 'json_schema', schema } — a bare schema is
      // silently ignored (no structured_output on the result message), and so
      // is a schema carrying zod's "$schema" draft-2020-12 marker (verified
      // live on Fable 5: success status, no structured_output). Strip it.
      const { $schema: _drop, ...schema } = z.toJSONSchema(req.outputSchema) as Record<
        string,
        unknown
      >;
      sdkInput.outputFormat = { type: 'json_schema', schema };
    }

    const result = await this.runSdk(sdkInput);

    // Record the REAL cost to the ledger (pool spend), keep it out of the dispatcher cap.
    this.ledger?.record({
      surface: 'provider',
      costUsd: result.costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      turns: result.turns,
      status: result.status,
      label: this.model,
    });

    return {
      text: result.text,
      // With outputFormat, the SDK parks the parsed JSON on structured_output and
      // `text` may be empty/prose — thread it through so callers don't re-parse text.
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: result.usage.cachedInputTokens }
          : {}),
      },
      // Pool-billed: report zero so the dispatcher's metered cap is unaffected.
      costUsd: 0,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }
}

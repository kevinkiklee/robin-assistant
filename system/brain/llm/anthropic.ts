import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
  /** Default output cap when a call doesn't set req.maxTokens (default 4096). */
  maxTokens?: number;
  /** Max retry attempts after the first try. Total tries = maxRetries (default 4). */
  maxRetries?: number;
  /** Overridable backoff sleep — inject a no-op in tests to keep them fast. */
  sleep?: (ms: number) => Promise<void>;
}

// Opus 4.8 list pricing, USD per million tokens (matches the default model
// below — override via cfg.meta if a role pins a different model).
const DEFAULT_INPUT_PRICE = 5.0;
const DEFAULT_OUTPUT_PRICE = 25.0;
// Anthropic bills cache reads at 10% of the base input rate.
const CACHE_READ_MULTIPLIER = 0.1;
// Anthropic requires max_tokens; bound it so a runaway generation can't rack up cost.
const DEFAULT_MAX_TOKENS = 4096;
// Retry on transient/overload statuses only. 400/401 are caller errors — never retry.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

const API_URL = 'https://api.anthropic.com/v1/messages';

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private apiKey: string;
  private model: string;
  private defaultMaxTokens: number;
  private maxRetries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(cfg: AnthropicProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? 'claude-opus-4-8';
    this.defaultMaxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = cfg.maxRetries ?? 4;
    this.sleep = cfg.sleep ?? defaultSleep;
    this.capabilities = new Set(cfg.capabilities ?? ['summarize', 'reasoning', 'agentic']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 1_000_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? DEFAULT_INPUT_PRICE,
      outputPricePerM: cfg.meta?.outputPricePerM ?? DEFAULT_OUTPUT_PRICE,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();

    // Anthropic takes the system prompt top-level (string or structured blocks),
    // NOT as a message. Map only user/assistant turns into `messages`.
    const messages = req.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    // NOTE: `temperature` is intentionally NOT sent. Fable 5 and Opus 4.7+ removed
    // sampling params — sending any value, including the callers' explicit
    // `temperature: 0`, returns HTTP 400 (verified live on Opus 4.7 2026-05-24).
    // Likewise no `thinking` param: Fable 5 rejects an explicit
    // {type: "disabled"} — omitting it entirely is the only way to run without
    // thinking. If an older Claude model is ever configured here, reintroduce
    // temperature guarded by model.
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages,
    };
    if (req.systemPrompt) {
      // Always cache the (typically large, stable) system prompt; honor an
      // explicit cacheable flag too. Structured form is required to attach
      // cache_control.
      const cacheable = req.cacheable !== false;
      body.system = cacheable
        ? [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
        : req.systemPrompt;
    }

    const res = await this.fetchWithRetry(body);
    const data = (await res.json()) as AnthropicResponse;

    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');

    const totalInput = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const cachedInputTokens = data.usage?.cache_read_input_tokens;

    // input_tokens already excludes cache reads in the Anthropic API, so price
    // the uncached portion at full rate and the cached portion at 10%.
    const cached = cachedInputTokens ?? 0;
    const costUsd =
      (totalInput / 1_000_000) * this.meta.inputPricePerM +
      (cached / 1_000_000) * this.meta.inputPricePerM * CACHE_READ_MULTIPLIER +
      (outputTokens / 1_000_000) * this.meta.outputPricePerM;

    return {
      text,
      usage: {
        inputTokens: totalInput,
        outputTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      },
      costUsd,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }

  private async fetchWithRetry(body: Record<string, unknown>): Promise<Response> {
    let lastStatus = 0;
    let lastBody = '';
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;

      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');

      const isLast = attempt === this.maxRetries - 1;
      if (!RETRYABLE_STATUSES.has(res.status) || isLast) {
        throw new Error(`anthropic ${res.status}: ${lastBody}`);
      }

      // Exponential backoff with jitter: 250ms, 500ms, 1000ms, … plus 0–250ms.
      const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 250);
      await this.sleep(backoff);
    }
    // Unreachable in practice — the loop always throws on its final iteration.
    throw new Error(`anthropic ${lastStatus}: ${lastBody}`);
  }
}

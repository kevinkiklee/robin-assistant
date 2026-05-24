import type {
  InvokeRequest,
  InvokeResult,
  LLMProvider,
  LLMRole,
  Message,
  ProviderMeta,
} from './types.ts';

export interface GoogleProviderConfig {
  apiKey: string;
  model?: string;
  embedModel?: string;
  embedDims?: number;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
  /** Default output cap when a call doesn't set req.maxTokens (default 4096). */
  maxTokens?: number;
  /** Base URL override (mostly for tests). */
  baseUrl?: string;
  /**
   * Backoff sleeper. Defaults to a real exponential-backoff-with-jitter delay.
   * Inject a no-op (`async () => {}`) to make retry paths fast in tests.
   */
  sleep?: (ms: number) => Promise<void>;
}

// Gemini 3 Pro pricing (USD per 1M tokens).
const DEFAULT_INPUT_PRICE = 2.0;
const DEFAULT_OUTPUT_PRICE = 12.0;

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 4;
const RETRY_STATUS = new Set([429, 500, 502, 503]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface GeminiPart {
  text?: string;
}

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface EmbedResponse {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}

export class GoogleProvider implements LLMProvider {
  readonly name = 'google';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private apiKey: string;
  private model: string;
  private embedModel: string;
  private embedDims: number;
  private defaultMaxTokens: number;
  private baseUrl: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(cfg: GoogleProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? 'gemini-3-pro';
    this.embedModel = cfg.embedModel ?? 'gemini-embedding-2';
    this.embedDims = cfg.embedDims ?? 3072;
    this.defaultMaxTokens = cfg.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.sleep = cfg.sleep ?? defaultSleep;
    this.capabilities = new Set(cfg.capabilities ?? ['reasoning', 'summarize', 'agentic', 'embed']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 1_000_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? DEFAULT_INPUT_PRICE,
      outputPricePerM: cfg.meta?.outputPricePerM ?? DEFAULT_OUTPUT_PRICE,
      avgLatencyMs: cfg.meta?.avgLatencyMs,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const contents = req.messages.map((m: Message) => ({
      // Gemini contents have no 'system' role; the caller's systemPrompt is
      // carried separately via system_instruction. 'assistant' → 'model'.
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
      // Bounded default to prevent runaway output cost.
      maxOutputTokens: req.maxTokens ?? this.defaultMaxTokens,
    };
    if (req.outputSchema) {
      generationConfig.responseMimeType = 'application/json';
      // TODO: set generationConfig.responseSchema by converting the zod schema
      // to a JSON schema. `zod-to-json-schema` is not a dependency, so we only
      // request JSON output for now and let the caller validate downstream.
    }

    const body: Record<string, unknown> = { contents, generationConfig };
    if (req.systemPrompt) {
      body.system_instruction = { parts: [{ text: req.systemPrompt }] };
    }

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const data = (await this.request(url, body)) as GenerateContentResponse;

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * this.meta.inputPricePerM +
      (outputTokens / 1_000_000) * this.meta.outputPricePerM;

    return {
      text,
      usage: { inputTokens, outputTokens },
      costUsd,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const inputs = Array.isArray(text) ? text : [text];

    if (Array.isArray(text)) {
      const url = `${this.baseUrl}/v1beta/models/${this.embedModel}:batchEmbedContents`;
      const body = {
        requests: inputs.map((t) => ({
          model: `models/${this.embedModel}`,
          content: { parts: [{ text: t }] },
          outputDimensionality: this.embedDims,
        })),
      };
      const data = (await this.request(url, body)) as EmbedResponse;
      return (data.embeddings ?? []).map((e) => e.values ?? []);
    }

    const url = `${this.baseUrl}/v1beta/models/${this.embedModel}:embedContent`;
    const body = {
      model: `models/${this.embedModel}`,
      content: { parts: [{ text: inputs[0] }] },
      outputDimensionality: this.embedDims,
    };
    const data = (await this.request(url, body)) as EmbedResponse;
    return [data.embedding?.values ?? []];
  }

  /** POST JSON with retry/backoff on transient (429/5xx) statuses. */
  private async request(url: string, body: unknown): Promise<unknown> {
    let lastStatus = 0;
    let lastText = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();

      lastStatus = res.status;
      lastText = await res.text();
      if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS - 1) break;

      // Exponential backoff with full jitter: base 250ms, doubling per attempt.
      const backoff = 250 * 2 ** attempt;
      await this.sleep(Math.random() * backoff);
    }
    throw new Error(`google ${lastStatus}: ${lastText}`);
  }
}

import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

// EMBEDDINGS ONLY. The Gemini chat path (invoke + responseSchema conversion) was
// removed 2026-06-10 with the Claude-only policy: all generation/reasoning runs
// on Claude (anthropic / claude-agent providers); Google serves nothing but
// Gemini Embedding 2 vectors for events_vec (migration 010, float[3072]).
// Restoring chat means reimplementing invoke() — see git history pre-2026-06-10.
export interface GoogleProviderConfig {
  apiKey: string;
  embedModel?: string;
  embedDims?: number;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
  /** Base URL override (mostly for tests). */
  baseUrl?: string;
  /**
   * Backoff sleeper. Defaults to a real exponential-backoff-with-jitter delay.
   * Inject a no-op (`async () => {}`) to make retry paths fast in tests.
   */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 4;
const RETRY_STATUS = new Set([429, 500, 502, 503]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface EmbedResponse {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}

export class GoogleProvider implements LLMProvider {
  readonly name = 'google';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private apiKey: string;
  private embedModel: string;
  private embedDims: number;
  private baseUrl: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(cfg: GoogleProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.embedModel = cfg.embedModel ?? 'gemini-embedding-2';
    this.embedDims = cfg.embedDims ?? 3072;
    this.baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.sleep = cfg.sleep ?? defaultSleep;
    this.capabilities = new Set(cfg.capabilities ?? ['embed']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 0,
      // No chat path; embed cost isn't metered through provider meta.
      inputPricePerM: cfg.meta?.inputPricePerM ?? 0,
      outputPricePerM: cfg.meta?.outputPricePerM ?? 0,
      avgLatencyMs: cfg.meta?.avgLatencyMs,
    };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    throw new Error(
      "google provider is embed-only (Claude-only policy, 2026-06-10) — route LLM roles to 'anthropic' or 'claude-agent' in models.yaml",
    );
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

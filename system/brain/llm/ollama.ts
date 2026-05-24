import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

export interface OllamaProviderConfig {
  baseUrl?: string;
  chatModel: string;
  embedModel?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
  /** Cap the context window (Ollama `num_ctx`). Omit to use the model default. */
  numCtx?: number;
  /** Toggle qwen3.x thinking mode (Ollama `think`). false = skip reasoning phase. */
  think?: boolean;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private baseUrl: string;
  private chatModel: string;
  private embedModel?: string;
  private numCtx?: number;
  private think?: boolean;

  constructor(cfg: OllamaProviderConfig) {
    this.baseUrl = cfg.baseUrl ?? 'http://127.0.0.1:11434';
    this.chatModel = cfg.chatModel;
    this.embedModel = cfg.embedModel;
    this.numCtx = cfg.numCtx;
    this.think = cfg.think;
    this.capabilities = new Set(cfg.capabilities ?? ['classify', 'summarize', 'agentic', 'embed']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 32_768,
      inputPricePerM: 0,
      outputPricePerM: 0,
      avgLatencyMs: cfg.meta?.avgLatencyMs,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const messages = req.systemPrompt
      ? [{ role: 'system' as const, content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const options: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
      num_predict: req.maxTokens,
    };
    if (this.numCtx !== undefined) options.num_ctx = this.numCtx;
    const body: Record<string, unknown> = {
      model: this.chatModel,
      messages,
      stream: false,
      options,
    };
    if (this.think !== undefined) body.think = this.think;
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ollama chat ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      text: data.message?.content ?? '',
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      costUsd: 0,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }

  async embed(text: string | string[]): Promise<number[][]> {
    if (!this.embedModel) throw new Error('OllamaProvider: embedModel not configured');
    const inputs = Array.isArray(text) ? text : [text];
    const out: number[][] = [];
    for (const input of inputs) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, prompt: input }),
      });
      if (!res.ok) throw new Error(`ollama embeddings ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { embedding: number[] };
      out.push(data.embedding);
    }
    return out;
  }
}

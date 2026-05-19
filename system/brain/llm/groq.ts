import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

export interface GroqProviderConfig {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(cfg: GroqProviderConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.groq.com/openai/v1';
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? 'llama-3.3-70b-versatile';
    this.capabilities = new Set(cfg.capabilities ?? ['classify', 'summarize']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 128_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? 0,
      outputPricePerM: cfg.meta?.outputPricePerM ?? 0,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const messages = req.systemPrompt
      ? [{ role: 'system' as const, content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`groq ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      text: data.choices[0]?.message?.content ?? '',
      usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      costUsd: 0,
      latencyMs: Date.now() - start,
      provider: this.name,
    };
  }
}

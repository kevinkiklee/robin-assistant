import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole, ProviderMeta } from './types.ts';

export interface DeepSeekProviderConfig {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  capabilities?: LLMRole[];
  meta?: Partial<ProviderMeta>;
}

const DEFAULT_INPUT_PRICE = 0.14;
const DEFAULT_OUTPUT_PRICE = 0.28;

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(cfg: DeepSeekProviderConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.deepseek.com';
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? 'deepseek-chat';
    this.capabilities = new Set(cfg.capabilities ?? ['reasoning', 'agentic', 'summarize']);
    this.meta = {
      contextWindow: cfg.meta?.contextWindow ?? 128_000,
      inputPricePerM: cfg.meta?.inputPricePerM ?? DEFAULT_INPUT_PRICE,
      outputPricePerM: cfg.meta?.outputPricePerM ?? DEFAULT_OUTPUT_PRICE,
    };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const start = Date.now();
    const messages = req.systemPrompt
      ? [{ role: 'system' as const, content: req.systemPrompt }, ...req.messages]
      : req.messages;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `deepseek ${res.status}: ${errText.length > 500 ? `${errText.slice(0, 500)}…` : errText}`,
      );
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const text = data.choices[0]?.message?.content ?? '';
    const inputTokens = data.usage.prompt_tokens;
    const outputTokens = data.usage.completion_tokens;
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
}

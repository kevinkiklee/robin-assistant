import type { ZodSchema } from 'zod';

export type LLMRole =
  | 'interactive'
  | 'agentic'
  | 'reasoning'
  | 'summarize'
  | 'classify'
  | 'embed'
  | 'rerank';

export interface ProviderMeta {
  contextWindow: number;
  inputPricePerM: number;
  outputPricePerM: number;
  avgLatencyMs?: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface InvokeRequest {
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolDef[];
  outputSchema?: ZodSchema;
  maxTokens?: number;
  temperature?: number;
  cacheable?: boolean;
}

export interface InvokeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface InvokeResult {
  text: string;
  structured?: unknown;
  toolCalls?: ToolCall[];
  usage: InvokeUsage;
  costUsd: number;
  latencyMs: number;
  provider: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly capabilities: Set<LLMRole>;
  readonly meta: ProviderMeta;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
  embed?(text: string | string[]): Promise<number[][]>;
}

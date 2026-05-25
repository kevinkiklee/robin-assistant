import { z } from 'zod';
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

// Gemini's responseSchema is an OpenAPI-3.0 Schema subset: UPPERCASE `type`
// strings (STRING/NUMBER/INTEGER/BOOLEAN/ARRAY/OBJECT), `nullable` instead of a
// `[..,null]` union, and a limited keyword set (type, format, description, enum,
// items, properties, required, nullable). We carry only those.
interface GeminiSchema {
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
}

const JSON_TYPE_TO_GEMINI: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

// Formats Gemini's responseSchema recognizes. JSON Schema emits many more
// (email, uri, uuid, …); passing an unrecognized one is rejected, so we drop them.
const GEMINI_FORMATS = new Set(['date-time', 'enum', 'int32', 'int64', 'float', 'double']);

type JsonSchema = Record<string, unknown>;

/**
 * Convert a JSON Schema (as produced by `z.toJSONSchema`) into Gemini's
 * OpenAPI-subset responseSchema. Returns null when there's nothing usable to map
 * (e.g. an empty/typeless schema) so the caller can fall back to JSON-only mode.
 *
 * Handles the shapes zod 4 emits for our extraction schemas: typed primitives,
 * objects with properties+required, arrays with `items`, enums, and the
 * `anyOf: [<schema>, {type:'null'}]` union that optionals/nullables compile to
 * (folded into `nullable: true`).
 */
export function jsonSchemaToGeminiSchema(schema: JsonSchema | undefined): GeminiSchema | null {
  if (!schema || typeof schema !== 'object') return null;

  // Nullable union: `anyOf`/`oneOf` of [<real schema>, {type:'null'}]. Collapse the
  // null branch into `nullable` and convert the single remaining branch.
  const union = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) {
    const isNull = (s: JsonSchema) => s?.type === 'null';
    const nonNull = union.filter((s) => !isNull(s));
    const hasNull = union.some(isNull);
    if (nonNull.length === 1) {
      const inner = jsonSchemaToGeminiSchema(nonNull[0]);
      if (!inner) return null;
      if (hasNull) inner.nullable = true;
      if (typeof schema.description === 'string') inner.description ??= schema.description;
      return inner;
    }
    // Genuine multi-branch unions aren't expressible in the subset — skip enforcement.
    return null;
  }

  const rawType = schema.type;
  // JSON Schema permits `type: [...]` (e.g. ["string","null"]); take the non-null one.
  let typeStr: string | undefined;
  let nullable = false;
  if (Array.isArray(rawType)) {
    nullable = rawType.includes('null');
    typeStr = rawType.find((t) => t !== 'null');
  } else if (typeof rawType === 'string') {
    typeStr = rawType;
  }
  if (!typeStr || !JSON_TYPE_TO_GEMINI[typeStr]) return null;

  const out: GeminiSchema = { type: JSON_TYPE_TO_GEMINI[typeStr] };
  if (nullable) out.nullable = true;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (typeof schema.format === 'string' && GEMINI_FORMATS.has(schema.format))
    out.format = schema.format;
  if (Array.isArray(schema.enum)) out.enum = (schema.enum as unknown[]).map((v) => String(v));

  if (typeStr === 'array') {
    const items = jsonSchemaToGeminiSchema(schema.items as JsonSchema | undefined);
    if (items) out.items = items;
  }

  if (typeStr === 'object' && schema.properties && typeof schema.properties === 'object') {
    const props: Record<string, GeminiSchema> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
      const converted = jsonSchemaToGeminiSchema(value);
      if (converted) props[key] = converted;
    }
    if (Object.keys(props).length > 0) out.properties = props;
    if (Array.isArray(schema.required))
      out.required = (schema.required as unknown[]).filter(
        (r): r is string => typeof r === 'string' && r in props,
      );
  }

  return out;
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
      // Convert the zod schema → JSON Schema (zod 4 ships this natively) → Gemini's
      // OpenAPI-subset responseSchema, so the model enforces the shape instead of us
      // only hoping for JSON. `target: 'draft-7'` keeps optionals as `anyOf:[…,null]`
      // unions, which jsonSchemaToGeminiSchema folds back into `nullable: true`.
      const jsonSchema = z.toJSONSchema(req.outputSchema, { target: 'draft-7' });
      const responseSchema = jsonSchemaToGeminiSchema(jsonSchema);
      if (responseSchema) generationConfig.responseSchema = responseSchema;
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

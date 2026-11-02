// lab/llm/template-provider.ts
//
// Deterministic in-process LLM provider: answers Robin's memory-pipeline prompts
// by parsing the lab's sentence grammar. No network, no credentials, zero cost.
import { getPrompt, type PromptKey } from '../../system/brain/cognition/prompts.ts';
import type {
  InvokeRequest,
  InvokeResult,
  LLMProvider,
  LLMRole,
} from '../../system/brain/llm/types.ts';
import { normalizeTopic } from '../../system/brain/memory/belief.ts';
import { claimSentence, domainForLabel, parseClaim, parseStatements } from '../render/grammar.ts';

/** Width of `events_vec` in the newest migration (023-events-vec-int8: int8[3072]). */
export const EMBED_DIM = 3072;

export class LabUnhandledPromptError extends Error {
  constructor(prompt: string) {
    super(`lab template provider has no handler for prompt: ${prompt.slice(0, 80)}`);
    this.name = 'LabUnhandledPromptError';
  }
}

export interface TemplateStats {
  calls: Record<string, number>;
  unhandled: string[];
}

export interface TemplateProvider extends LLMProvider {
  stats: TemplateStats;
}

const ALL_ROLES: LLMRole[] = [
  'interactive',
  'reasoning',
  'summarize',
  'classify',
  'embed',
  'rerank',
];

const DISAMBIGUATE_PREFIX = 'You disambiguate entity references';

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function embedOne(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[fnv1a(tok) % EMBED_DIM] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function judge(content: string): { text: string; structured: unknown } {
  const lines = content.split('\n');
  const verdicts: { item: number; verdict: string }[] = [];
  let item = -1;
  let current: string | null = null;
  const flush = (nw: string) => {
    const a = current ? parseClaim(current) : null;
    const b = parseClaim(nw);
    const verdict =
      a && b && a.label === b.label ? (a.value === b.value ? 'same' : 'refines') : 'unrelated';
    verdicts.push({ item, verdict });
    current = null;
  };
  for (const line of lines) {
    const it = /^ITEM (\d+) \(topic /.exec(line);
    if (it) {
      item = Number(it[1]);
      current = null;
      continue;
    }
    const cur = /^ {2}current \([^)]*\): (.*)$/.exec(line);
    if (cur) {
      current = cur[1];
      continue;
    }
    const nw = /^ {2}new: (.*)$/.exec(line);
    if (nw && item >= 0) flush(nw[1]);
  }
  const structured = { verdicts };
  return { text: JSON.stringify(structured), structured };
}

/** The biographer's own test for a transcript chunk (role markers); anything else is a doc. */
const TRANSCRIPT = /\[(USER|ASSISTANT|TOOL|SYSTEM)\]/i;

function claims(content: string): string {
  const out: { topic: string; claim: string; confidence: number; domain: string }[] = [];
  let statements = parseStatements(content);
  if (!TRANSCRIPT.test(content)) {
    // A doc is a decision tracker that keeps its history: its current state per label is
    // the last line, so only that one is a claim.
    const last = new Map(statements.map((s) => [s.label, s]));
    statements = statements.filter((s) => last.get(s.label) === s);
  }
  for (const s of statements) {
    const domain = domainForLabel(s.label);
    if (!domain) continue;
    out.push({
      topic: normalizeTopic(s.label),
      claim: claimSentence(s.label, s.value),
      confidence: s.confidence,
      domain,
    });
  }
  return JSON.stringify({ claims: out });
}

const KEYED: PromptKey[] = [
  'biographer.claims',
  'biographer.entities',
  'biographer.sessionSummary',
  'reconcile.judge',
  'dream.entityProfile',
];

export function createTemplateProvider(): TemplateProvider {
  const stats: TemplateStats = { calls: {}, unhandled: [] };

  const answer = (req: InvokeRequest): { key: string; text: string; structured?: unknown } => {
    const sys = req.systemPrompt ?? '';
    const user = req.messages.map((m) => m.content).join('\n');
    const key =
      KEYED.find((k) => sys === getPrompt(k)) ??
      (sys.startsWith(DISAMBIGUATE_PREFIX) ? 'disambiguate' : null);
    switch (key) {
      case 'biographer.claims':
        return { key, text: claims(user) };
      case 'biographer.entities':
        return { key, text: JSON.stringify({ entities: [], relations: [] }) };
      case 'biographer.sessionSummary':
        return {
          key,
          text: JSON.stringify({
            intent: 'Sim session',
            outcome: 'exploratory',
            outcomeSummary: 'Sim session',
            topics: ['sim-session', 'sim-day'],
            decisions: [],
            temporalRefs: [],
            followUp: null,
          }),
        };
      case 'reconcile.judge':
        return { key, ...judge(user) };
      case 'dream.entityProfile':
        return { key, text: 'Sim entity profile.' };
      case 'disambiguate':
        return {
          key,
          text: JSON.stringify({ matched_id: null, create_new: true, reason: 'lab' }),
        };
      default:
        stats.unhandled.push(sys.slice(0, 80));
        throw new LabUnhandledPromptError(sys);
    }
  };

  return {
    name: 'lab-template',
    capabilities: new Set<LLMRole>(ALL_ROLES),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    stats,
    async invoke(req) {
      const { key, text, structured } = answer(req);
      stats.calls[key] = (stats.calls[key] ?? 0) + 1;
      const input = (req.systemPrompt ?? '') + req.messages.map((m) => m.content).join('');
      const result: InvokeResult = {
        text,
        ...(structured !== undefined ? { structured } : {}),
        usage: {
          inputTokens: Math.ceil(input.length / 4),
          outputTokens: Math.ceil(text.length / 4),
        },
        costUsd: 0,
        latencyMs: 0,
        provider: 'lab-template',
      };
      return result;
    },
    async embed(text) {
      return (Array.isArray(text) ? text : [text]).map(embedOne);
    },
  };
}

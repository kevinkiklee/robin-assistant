import type { ModelsConfig, ProviderConfig } from '../../kernel/config/schema.ts';
import { AnthropicProvider } from './anthropic.ts';
import { ClaudeAgentProvider } from './claude-agent.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { LLMDispatcher } from './dispatcher.ts';
import { GoogleProvider } from './google.ts';
import { OllamaProvider } from './ollama.ts';
import type { LLMProvider, LLMRole } from './types.ts';

function resolveSecret(env: NodeJS.ProcessEnv, key?: string): string {
  if (!key) return '';
  const v = env[key];
  if (!v) throw new Error(`Required secret '${key}' is not set in environment`);
  return v;
}

// Supported providers:
// - google: cloud, the daemon's default reasoning + embedding path (2026-05-24).
// - anthropic: cloud, the summarize/complex-cognition path (Claude Opus).
// - ollama: local. Adapter kept in place for swap-back, but no role routes to it
//   post-cloud-migration (Ollama uninstalled from disk 2026-05-24; reinstall +
//   repoint models.yaml to revert).
// - deepseek: dormant cloud escape hatch; not routed by any role.
// - claude-agent: cloud, pool-/subscription-billed via the Claude Agent SDK on a pinned
//   cheap model; reports costUsd:0 so prepaid pool dollars don't inflate the metered cap.
function build(name: string, cfg: ProviderConfig, env: NodeJS.ProcessEnv): LLMProvider {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: cfg.baseUrl,
        chatModel: cfg.model ?? 'qwen3:8b',
        embedModel: cfg.model,
        numCtx: cfg.numCtx,
        think: cfg.think,
      });
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'CLAUDE_API_KEY'),
        model: cfg.model,
        maxTokens: cfg.maxTokens,
      });
    case 'claude-agent':
      // Pool-/subscription-billed via the Claude Agent SDK. Pinned to a cheap model
      // (the SDK preamble makes a default-Opus call expensive). Reports costUsd:0 to
      // the dispatcher cap; real spend is recorded to the UsageLedger when wired in.
      return new ClaudeAgentProvider({ model: cfg.model ?? 'claude-haiku-4-5' });
    case 'google':
      return new GoogleProvider({
        apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'GEMINI_API_KEY'),
        model: cfg.model,
        // For the embed role, cfg.model is the embedding model; carry it into
        // embedModel too so a google-embed role resolves correctly. embedDims
        // sizes the vector to match the events_vec schema (migration 010 = 3072).
        embedModel: cfg.embedModel ?? cfg.model,
        embedDims: cfg.embedDims,
        maxTokens: cfg.maxTokens,
      });
    case 'deepseek':
      return new DeepSeekProvider({
        baseUrl: cfg.baseUrl,
        apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'DEEPSEEK_API_KEY'),
        model: cfg.model,
      });
    default:
      throw new Error(`Unknown provider '${cfg.provider}' for role '${name}'`);
  }
}

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  lenient?: boolean;
  onWarn?: (msg: string) => void;
}

export function buildDispatcherFromConfig(
  models: ModelsConfig,
  opts: BuildOptions = {},
): LLMDispatcher {
  const env = opts.env ?? process.env;
  // Daily cloud-spend cap (USD). Disabled (0) unless ROBIN_LLM_DAILY_USD_CAP is set;
  // defaults to $10/day once any cloud provider is in play. Trips SpendCapError,
  // which the biographer circuit breaker treats as an outage (no data loss).
  const capRaw = env.ROBIN_LLM_DAILY_USD_CAP;
  const usesCloud = Object.values(models.roles).some(
    (c) => c.provider === 'anthropic' || c.provider === 'google' || c.provider === 'deepseek',
  );
  const dailyCostCapUsd = capRaw !== undefined ? Number(capRaw) : usesCloud ? 10 : 0;
  const d = new LLMDispatcher({ dailyCostCapUsd });
  const providersByName = new Map<string, LLMProvider>();

  for (const [role, cfg] of Object.entries(models.roles)) {
    const key = `${cfg.provider}:${cfg.model ?? 'default'}`;
    let provider = providersByName.get(key);
    if (!provider) {
      try {
        provider = build(role, cfg, env);
        providersByName.set(key, provider);
        d.register(key, provider);
      } catch (err) {
        const msg = `role '${role}' provider build failed: ${err instanceof Error ? err.message : err}`;
        if (opts.lenient) {
          opts.onWarn?.(msg);
          continue;
        }
        throw new Error(msg);
      }
    }
    d.assign(role as LLMRole, key);
  }
  return d;
}

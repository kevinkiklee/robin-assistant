import type { UsageLedger } from '../../agent/usage-ledger.ts';
import type { ModelsConfig, ProviderConfig } from '../../kernel/config/schema.ts';
import { AnthropicProvider } from './anthropic.ts';
import { ClaudeAgentProvider } from './claude-agent.ts';
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
// - google: cloud, EMBEDDINGS ONLY (Gemini Embedding 2 → events_vec). The chat
//   path was removed 2026-06-10 (Claude-only policy) — GoogleProvider.invoke throws.
// - anthropic: cloud, metered Claude API (Opus 4.8 default).
// - ollama: local. Adapter kept in place for swap-back, but no role routes to it
//   post-cloud-migration (Ollama uninstalled from disk 2026-05-24; reinstall +
//   repoint models.yaml to revert).
// - claude-agent: cloud, pool-/subscription-billed via the Claude Agent SDK on a pinned
//   cheap model; reports costUsd:0 so prepaid pool dollars don't inflate the metered cap.
/**
 * Dedupe key for a provider instance. Roles sharing provider+model share one
 * instance — unless a per-role knob that changes the call (effort) differs, so
 * e.g. classify at effort:low never leaks onto reasoning on the same model.
 */
function providerKey(cfg: ProviderConfig | NonNullable<ProviderConfig['fallback']>): string {
  const base = `${cfg.provider}:${cfg.model ?? 'default'}`;
  return cfg.effort ? `${base}:effort=${cfg.effort}` : base;
}

function build(
  name: string,
  cfg: ProviderConfig,
  env: NodeJS.ProcessEnv,
  ledger?: UsageLedger,
): LLMProvider {
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
      // the dispatcher cap; real spend is recorded to the UsageLedger (surface
      // 'provider', label = role) when the entry point has a DB to hand one in.
      return new ClaudeAgentProvider({
        model: cfg.model ?? 'claude-haiku-5-5',
        ...(cfg.effort ? { effort: cfg.effort } : {}),
        ...(ledger ? { ledger } : {}),
      });
    case 'google':
      return new GoogleProvider({
        apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'GEMINI_API_KEY'),
        // Embed-only: cfg.model is the embedding model for an embed role; accept
        // either field so existing models.yaml shapes keep working. embedDims
        // sizes the vector to match the events_vec schema (migration 010 = 3072).
        embedModel: cfg.embedModel ?? cfg.model,
        embedDims: cfg.embedDims,
      });
    default:
      throw new Error(`Unknown provider '${cfg.provider}' for role '${name}'`);
  }
}

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  lenient?: boolean;
  onWarn?: (msg: string) => void;
  /**
   * Ledger for pool-billed (claude-agent) spend. Rows land under surface
   * 'provider', which no agentic per-surface cap reads — so wiring it makes
   * spend visible without changing any cap. Optional: entry points without a
   * DB (none today) simply don't record.
   */
  ledger?: UsageLedger;
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
    (c) => c.provider === 'anthropic' || c.provider === 'google',
  );
  const dailyCostCapUsd = capRaw !== undefined ? Number(capRaw) : usesCloud ? 10 : 0;
  const d = new LLMDispatcher({ dailyCostCapUsd });
  const providersByName = new Map<string, LLMProvider>();

  for (const [role, cfg] of Object.entries(models.roles)) {
    const key = providerKey(cfg);
    let provider = providersByName.get(key);
    if (!provider) {
      try {
        provider = build(role, cfg, env, opts.ledger);
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

    // Usage-limit fallback (e.g. reasoning=Sonnet → Opus): build + register the
    // fallback provider (deduped like the primaries) and wire it so a
    // SubscriptionLimitError on the primary retries once against it. A fallback
    // that can't build is non-fatal in lenient mode (the role still works on its
    // primary); strict mode surfaces it like any other build failure.
    if (cfg.fallback) {
      const fbKey = providerKey(cfg.fallback);
      let fb = providersByName.get(fbKey);
      if (!fb) {
        try {
          fb = build(`${role}.fallback`, cfg.fallback, env, opts.ledger);
          providersByName.set(fbKey, fb);
          d.register(fbKey, fb);
        } catch (err) {
          const msg = `role '${role}' fallback provider build failed: ${err instanceof Error ? err.message : err}`;
          if (opts.lenient) {
            opts.onWarn?.(msg);
            fb = undefined;
          } else {
            throw new Error(msg);
          }
        }
      }
      if (fb) d.assignFallback(role as LLMRole, fbKey);
    }
  }
  return d;
}

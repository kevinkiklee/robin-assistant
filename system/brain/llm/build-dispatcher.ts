import type { ModelsConfig, ProviderConfig } from '../../kernel/config/schema.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { LLMDispatcher } from './dispatcher.ts';
import { OllamaProvider } from './ollama.ts';
import type { LLMProvider, LLMRole } from './types.ts';

function resolveSecret(env: NodeJS.ProcessEnv, key?: string): string {
  if (!key) return '';
  const v = env[key];
  if (!v) throw new Error(`Required secret '${key}' is not set in environment`);
  return v;
}

// Supported providers:
// - ollama: local-only, the default and the path the daemon uses today.
// - deepseek: dormant cloud escape hatch. Not routed by any role in
//   models.yaml; kept opt-in for future agentic-CLI experiments.
//
// Cloud agentic CLIs (claude-code, gemini-cli, groq) were removed in the
// 2026-05-22 cleanup. Robin's daemon is local-only by construction; manual
// LLM work runs through the user's interactive Claude Code subscription.
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
  const d = new LLMDispatcher();
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

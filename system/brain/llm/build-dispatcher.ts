import { LLMDispatcher } from './dispatcher.ts';
import { OllamaProvider } from './ollama.ts';
import { ClaudeCodeProvider } from './claude-code.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { GroqProvider } from './groq.ts';
import type { LLMRole, LLMProvider } from './types.ts';
import type { ModelsConfig, ProviderConfig } from '../../kernel/config/schema.ts';

function resolveSecret(env: NodeJS.ProcessEnv, key?: string): string {
  if (!key) return '';
  const v = env[key];
  if (!v) throw new Error(`Required secret '${key}' is not set in environment`);
  return v;
}

function build(name: string, cfg: ProviderConfig, env: NodeJS.ProcessEnv): LLMProvider {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: cfg.baseUrl, chatModel: cfg.model ?? 'qwen3:8b', embedModel: cfg.model });
    case 'claude-code':
    case 'claude-code-cli':
      return new ClaudeCodeProvider({});
    case 'deepseek':
      return new DeepSeekProvider({ baseUrl: cfg.baseUrl, apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'DEEPSEEK_API_KEY'), model: cfg.model });
    case 'groq':
      return new GroqProvider({ baseUrl: cfg.baseUrl, apiKey: resolveSecret(env, cfg.apiKeyEnv ?? 'GROQ_API_KEY'), model: cfg.model });
    default:
      throw new Error(`Unknown provider '${cfg.provider}' for role '${name}'`);
  }
}

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  lenient?: boolean;
  onWarn?: (msg: string) => void;
}

export function buildDispatcherFromConfig(models: ModelsConfig, opts: BuildOptions = {}): LLMDispatcher {
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

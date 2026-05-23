import { withTimeout } from '../../lib/with-timeout.ts';
import type { InvokeRequest, InvokeResult, LLMProvider, LLMRole } from './types.ts';

/**
 * Default ceiling for any LLM invocation (5 min). Bug F mitigation: every
 * provider call now passes through `withTimeout` so a hung Ollama (or any
 * provider) request cannot block the caller indefinitely. The dispatcher is
 * the single chokepoint — adding a new caller anywhere in the codebase
 * automatically picks up the ceiling. Handlers wanting tighter bounds
 * override per-call via `req.timeoutMs`.
 *
 * 5 min picked well above legitimate worst-case (qwen3:14b reasoning runs at
 * ~30-60s, with rare cold-start outliers around 2 min). Tighter risks
 * flagging real work as failures; looser leaves Scheduler.tickOnce blocked
 * past the lease TTL.
 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EMBED_TIMEOUT_MS = 2 * 60_000;

export interface LLMDispatcherOptions {
  /** Override the default invoke ceiling. Used by tests; production should use the default. */
  defaultInvokeTimeoutMs?: number;
  /** Override the default embed ceiling. Used by tests; production should use the default. */
  defaultEmbedTimeoutMs?: number;
}

export class LLMDispatcher {
  private providers = new Map<string, LLMProvider>();
  private roleAssignments = new Map<LLMRole, string>();
  private defaultInvokeTimeoutMs: number;
  private defaultEmbedTimeoutMs: number;

  constructor(opts: LLMDispatcherOptions = {}) {
    this.defaultInvokeTimeoutMs = opts.defaultInvokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.defaultEmbedTimeoutMs = opts.defaultEmbedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  register(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  assign(role: LLMRole, providerName: string): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider '${providerName}' not registered`);
    }
    this.roleAssignments.set(role, providerName);
  }

  getProvider(role: LLMRole): LLMProvider {
    const name = this.roleAssignments.get(role);
    if (!name) throw new Error(`No provider assigned for role '${role}'`);
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider '${name}' missing (assigned but not registered)`);
    return p;
  }

  invoke(role: LLMRole, req: InvokeRequest): Promise<InvokeResult> {
    const provider = this.getProvider(role);
    const ms = req.timeoutMs ?? this.defaultInvokeTimeoutMs;
    return withTimeout(provider.invoke(req), ms, `LLMDispatcher.invoke role=${role}`);
  }

  embed(role: LLMRole, text: string | string[]): Promise<number[][]> {
    const p = this.getProvider(role);
    if (!p.embed) throw new Error(`Provider '${p.name}' does not support embeddings`);
    return withTimeout(
      p.embed(text),
      this.defaultEmbedTimeoutMs,
      `LLMDispatcher.embed role=${role}`,
    );
  }
}

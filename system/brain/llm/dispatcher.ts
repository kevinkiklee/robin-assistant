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
const DEFAULT_INVOKE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EMBED_TIMEOUT_MS = 2 * 60_000;

/**
 * Thrown when the daily LLM spend cap is reached. Its message contains
 * "spend cap exceeded" so callers' LLM-unavailable detection (e.g. the
 * biographer circuit breaker) treats it like a transient outage — aborting
 * the tick WITHOUT advancing the cursor or writing empty results — rather
 * than a per-chunk failure that would silently lose extraction. This is the
 * load-bearing safety property when moving from $0 local to per-token cloud:
 * a runaway loop (cf. the biographer restart-loop) trips the cap and stops,
 * instead of burning money.
 */
export class SpendCapError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(`LLM daily spend cap exceeded: $${spentUsd.toFixed(2)} ≥ $${capUsd.toFixed(2)}`);
    this.name = 'SpendCapError';
  }
}

export interface LLMDispatcherOptions {
  /** Override the default invoke ceiling. Used by tests; production should use the default. */
  defaultInvokeTimeoutMs?: number;
  /** Override the default embed ceiling. Used by tests; production should use the default. */
  defaultEmbedTimeoutMs?: number;
  /**
   * Daily spend ceiling (USD) across all `invoke` calls. When the rolling
   * UTC-day total reaches this, further invokes throw `SpendCapError` until
   * the day rolls over. `undefined`/`0` disables the cap (e.g. local Ollama,
   * where every call is free). Embeddings are negligible + interactive
   * (recall), so they accumulate but are never blocked.
   */
  dailyCostCapUsd?: number;
}

/**
 * True when an error is a usage-limit OUTAGE that a configured fallback should
 * absorb: the claude-agent provider's SubscriptionLimitError (message
 * "subscription limit: …" — a weekly/daily subscription cap or an empty
 * completion). Deliberately NOT the spend cap (a budget brake — falling back
 * would defeat it) and NOT timeouts or bad output (those are per-chunk poison,
 * not "the account is down", and fallback would just double the latency).
 */
function isUsageLimitOutage(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /subscription limit/i.test(msg);
}

export class LLMDispatcher {
  private providers = new Map<string, LLMProvider>();
  private roleAssignments = new Map<LLMRole, string>();
  private fallbackAssignments = new Map<LLMRole, string>();
  private defaultInvokeTimeoutMs: number;
  private defaultEmbedTimeoutMs: number;
  private dailyCostCapUsd: number;
  private spentUsd = 0;
  private spendDay = '';

  constructor(opts: LLMDispatcherOptions = {}) {
    this.defaultInvokeTimeoutMs = opts.defaultInvokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.defaultEmbedTimeoutMs = opts.defaultEmbedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.dailyCostCapUsd = opts.dailyCostCapUsd ?? 0;
  }

  /** Today's accumulated invoke spend (USD), for telemetry/health surfacing. */
  getDailySpendUsd(): number {
    this.rollDay();
    return this.spentUsd;
  }

  private rollDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.spendDay) {
      this.spendDay = today;
      this.spentUsd = 0;
    }
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

  /**
   * Register a usage-limit fallback for a role: when the primary provider throws
   * a usage-limit outage (SubscriptionLimitError), `invoke` retries the same
   * request once against `providerName`. No-op unless the primary actually hits
   * a usage limit — a healthy primary never touches the fallback.
   */
  assignFallback(role: LLMRole, providerName: string): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Fallback provider '${providerName}' not registered`);
    }
    this.fallbackAssignments.set(role, providerName);
  }

  getProvider(role: LLMRole): LLMProvider {
    const name = this.roleAssignments.get(role);
    if (!name) throw new Error(`No provider assigned for role '${role}'`);
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider '${name}' missing (assigned but not registered)`);
    return p;
  }

  /** The role's usage-limit fallback provider, if one was assigned (else undefined). */
  getFallbackProvider(role: LLMRole): LLMProvider | undefined {
    const name = this.fallbackAssignments.get(role);
    return name ? this.providers.get(name) : undefined;
  }

  async invoke(role: LLMRole, req: InvokeRequest): Promise<InvokeResult> {
    // Spend cap (cloud only — cap of 0 disables). Checked BEFORE the call so a
    // runaway loop stops cleanly; SpendCapError reads as "LLM unavailable" to
    // the biographer circuit breaker, so no empty extraction is written.
    if (this.dailyCostCapUsd > 0) {
      this.rollDay();
      if (this.spentUsd >= this.dailyCostCapUsd) {
        throw new SpendCapError(this.spentUsd, this.dailyCostCapUsd);
      }
    }
    const provider = this.getProvider(role);
    const ms = req.timeoutMs ?? this.defaultInvokeTimeoutMs;
    let result: InvokeResult;
    try {
      result = await withTimeout(provider.invoke(req), ms, `LLMDispatcher.invoke role=${role}`);
    } catch (err) {
      // Usage-limit fallback (e.g. reasoning=Sonnet → Opus): when the primary is
      // usage-limited, retry the SAME request once on the role's fallback provider,
      // whose limit is independent. Only a usage-limit outage triggers this — bad
      // output, timeouts, and the spend cap propagate so callers handle them as
      // before. A fallback that also throws surfaces ITS error (the real state).
      const fbName = this.fallbackAssignments.get(role);
      const fb = fbName ? this.providers.get(fbName) : undefined;
      if (!fb || !isUsageLimitOutage(err)) throw err;
      result = await withTimeout(
        fb.invoke(req),
        ms,
        `LLMDispatcher.invoke role=${role} fallback=${fbName}`,
      );
    }
    if (this.dailyCostCapUsd > 0) {
      this.rollDay();
      this.spentUsd += result.costUsd ?? 0;
    }
    return result;
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

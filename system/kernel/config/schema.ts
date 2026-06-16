import { z } from 'zod';

export const powerSchema = z.object({
  state: z.enum(['active', 'paused', 'off']).default('active'),
  // Provenance of the current state, persisted so it survives daemon restarts.
  // `set_by` lets the power auto-monitor distinguish an auto-applied pause (which
  // it may auto-resume on AC) from a deliberate manual pause (which it must not
  // silently override). `since` is the ISO timestamp the state last changed — used
  // for operator-facing messaging and the scheduler-stall alarm. Both optional so
  // pre-existing policies.yaml files (and tests) parse without them.
  set_by: z.enum(['user', 'auto']).optional(),
  since: z.string().optional(),
  auto: z
    .object({
      on_low_power_mode: z.enum(['active', 'paused']).optional(),
      on_battery_below_pct: z.number().int().min(0).max(100).optional(),
      auto_resume_on_ac: z.boolean().default(true),
      quiet_hours: z
        .object({
          start: z.string().regex(/^\d{2}:\d{2}$/),
          end: z.string().regex(/^\d{2}:\d{2}$/),
          mode: z.enum(['online', 'local-only', 'offline']).default('local-only'),
        })
        .optional(),
    })
    .default({ auto_resume_on_ac: true }),
});

export const captureSchema = z.object({
  enabled: z.boolean().default(true),
  expires_at: z.string().datetime().optional(),
  blocked_paths: z.array(z.string()).default([]),
});

export const networkSchema = z.object({
  mode: z.enum(['online', 'local-only', 'offline']).default('online'),
  metered_ssids: z.array(z.string()).default([]),
  on_metered: z.enum(['online', 'local-only', 'offline']).optional(),
});

// Per-integration staleness alerting overrides for the integration-staleness
// invariant. `exempt` silences an integration entirely (e.g. one that legitimately
// has no fresh data for long stretches). The multipliers scale how many nominal
// cadences must pass with no successful tick before warn / critical fire; the
// invariant applies the defaults (3× / 10×) when a field is absent. Keyed by
// integration instance name. Default {} so existing policies.yaml without an
// alerts block still parses.
export const alertsPolicySchema = z
  .object({
    staleness: z
      .record(
        z.string(),
        z.object({
          exempt: z.boolean().optional(),
          warn_multiplier: z.number().positive().optional(), // default 3 applied in invariant
          critical_multiplier: z.number().positive().optional(), // default 10 applied in invariant
        }),
      )
      .default({}),
  })
  .default({ staleness: {} });

// Notifications surface here are operational, not content — daemon-unhealthy alerts,
// critical invariant failures, things the daemon couldn't recover from on its own.
// User-facing reminders / journal pings live elsewhere (the daily-brief job, etc.).
export const notificationsSchema = z.object({
  health: z.boolean().default(true),
});

export const linearConfigSchema = z.object({
  read_window_days: z.number().int().positive().default(14),
});

// Biographer (entity/relation extraction + claim drafting) tuning.
export const biographerConfigSchema = z.object({
  // Second-pass claim drafting: extract durable declarative facts into the
  // belief_candidates review queue. Separately gated so it can be disabled
  // without touching the hard-won entity/relation extraction stability ceilings.
  draftClaims: z.boolean().default(true),
});

// Claude Agent SDK execution policy: master kill-switch, per-surface daily spend
// caps, default session bounds (model/turns/timeout/budget), write-isolation toggle,
// pool-credit-exhaustion notification toggle, and the pool-billing switch. Nested
// blocks each carry per-field defaults so a partial override fills in siblings.
export const agentSchema = z.object({
  // OFF by default: agentic runs make real, paid SDK calls and the feature needs
  // live activation (route a provider role, wire MCP servers, validate pool
  // billing post-2026-06-15). Operators opt in by setting `enabled: true`.
  enabled: z.boolean().default(false),
  // prefault({}) (not default({})) so a missing or partial nested block still runs
  // the inner per-field defaults — default({}) would store the bare {} verbatim.
  caps: z
    .object({
      agentic_on_demand_daily_usd: z.number().nonnegative().default(50),
      agentic_autonomous_daily_usd: z.number().nonnegative().default(25),
    })
    .prefault({}),
  session: z
    .object({
      default_model: z.string().default('claude-sonnet-4-6'),
      default_max_turns: z.number().int().positive().default(30),
      default_timeout_ms: z.number().int().positive().default(1_800_000),
      default_max_budget_usd: z.number().nonnegative().default(5),
    })
    .prefault({}),
  write: z
    .object({
      file_checkpointing: z.boolean().default(true),
    })
    .prefault({}),
  credit: z
    .object({
      notify_on_exhaustion: z.boolean().default(true),
    })
    .prefault({}),
  bill_to_pool: z.boolean().default(true),
});

export const policiesSchema = z
  .object({
    power: powerSchema.optional(),
    capture: captureSchema.optional(),
    network: networkSchema.optional(),
    alerts: alertsPolicySchema.optional(),
    notifications: notificationsSchema.optional(),
    linear: linearConfigSchema.optional(),
    biographer: biographerConfigSchema.optional(),
    agent: agentSchema.optional(),
  })
  .transform((data) => ({
    power: powerSchema.parse(data.power ?? {}),
    capture: captureSchema.parse(data.capture ?? {}),
    network: networkSchema.parse(data.network ?? {}),
    alerts: alertsPolicySchema.parse(data.alerts ?? {}),
    notifications: notificationsSchema.parse(data.notifications ?? {}),
    linear: linearConfigSchema.parse(data.linear ?? {}),
    biographer: biographerConfigSchema.parse(data.biographer ?? {}),
    agent: agentSchema.parse(data.agent ?? {}),
  }));

export type Policies = z.infer<typeof policiesSchema>;

// Shared provider fields (everything except `fallback`). Factored out so a role's
// `fallback` can reuse the exact same shape WITHOUT recursively nesting another
// fallback (one level of fallback is enough — a fallback that also fails just
// propagates the outage).
const providerBaseSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  // Optional Ollama tuning. numCtx caps the context window (smaller = less KV-cache
  // memory + faster) — extraction/summary chunks are small, so the model's default
  // 256K context just wastes ~10GB of unified memory. think toggles qwen3.x thinking
  // mode; false skips the reasoning phase for big speed wins on structured tasks.
  numCtx: z.number().int().positive().optional(),
  think: z.boolean().optional(),
  // Cloud-provider tuning. maxTokens bounds output (prevents runaway cost/generation —
  // load-bearing for cloud where output is billed). embedModel/embedDims are used by
  // providers that serve both chat + embeddings (google) when the embed role needs a
  // different model/dimension than the chat model.
  maxTokens: z.number().int().positive().optional(),
  embedModel: z.string().optional(),
  embedDims: z.number().int().positive().optional(),
});

export const providerConfigSchema = providerBaseSchema.extend({
  // Usage-limit fallback: a SECOND provider used ONLY when the primary reports a
  // usage-limit outage (the claude-agent SubscriptionLimitError — a weekly/daily
  // subscription cap or an empty completion). The dispatcher retries the SAME
  // request once against it. Intended for a genuinely INDEPENDENT limit (e.g.
  // reasoning=Sonnet falling back to Opus), so a Sonnet weekly cap doesn't starve
  // cognition. NOT triggered by bad output, timeouts, or the spend cap.
  fallback: providerBaseSchema.optional(),
});

export const modelsSchema = z.object({
  roles: z.record(z.string(), providerConfigSchema).default({}),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;

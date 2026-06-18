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
  // Phase D personal-domain allowlist kill-switch. When true (default), claims
  // and entities outside PERSONAL_DOMAINS are dropped at extraction. Set to
  // false in policies.yaml to restore the old unrestricted ingestion behaviour
  // without a daemon restart.
  domainGating: z.boolean().default(true),
});

// Behavioral Habit Inference (Phase 2) policy. Restart-free config (resolved at
// handler time, same mechanism as biographer.domainGating) for the habit engine's
// master kill-switch and the soft→preference graduation thresholds. Defaults are
// conservative — graduation is rare by design (design §8).
export const behaviorConfigSchema = z.object({
  // Master kill-switch for the habit-inference engine (Tier A + Tier B). Default ON;
  // set false in policies.yaml to halt habit reinforcement/synthesis without a restart.
  enabled: z.boolean().default(true),
  // K: minimum support_count (across ≥2 distinct streams) for a soft habit to graduate.
  graduationSupport: z.number().int().positive().default(4),
  // X: minimum sustained age in weeks before a soft habit may graduate (not a spike).
  graduationWeeks: z.number().int().positive().default(3),
  // Personalization wire (design §9, Goal A). When true (default), the auto-recall
  // UserPromptSubmit hook injects up to 1–2 topically-relevant habits per turn as a
  // SEPARATE, softer-labeled hint block ("inferred tendency — hint, not fact") with its
  // own small budget — it never competes with the factual memory slots. Set false to
  // halt habit injection without a restart; factual recall is unaffected either way.
  injectHabits: z.boolean().default(true),
  // Surfacing (design §10, Goal B). When true (default), the daily brief may carry ONE
  // optional "Behavioral note:" line drawn from a graduated/strongly-reinforced habit
  // (sensitive domains excluded). Set false to suppress the unprompted surface.
  surfaceInBrief: z.boolean().default(true),
});

// Recommendation→Action Loop (Phase 1) policy. Restart-free config (resolved at handler
// time, same mechanism as behavior.*) for the linker's master kill-switch, how far back
// it scans behavioral signals, and the default expiry for recs with no explicit expiry.
export const recommendationsConfigSchema = z.object({
  // Master kill-switch for the recommendation→action linker. Default ON; set false in
  // policies.yaml to halt linking/expiry/emission without a restart.
  enabled: z.boolean().default(true),
  // How far back (days) the linker scans behavioral signals when matching open recs.
  linkWindowDays: z.number().int().positive().default(60),
  // Default expiry (days) applied to recs with no explicit `expires_at`.
  defaultExpiryDays: z.number().int().positive().default(90),
});

// Recommendation session-scan backfill (Phase 1.1) policy. Restart-free config (resolved at
// handler time, same mechanism as recommendations.*) for the weekly LLM job that recovers
// substantive recommendations Robin made but never logged. Separate block from
// `recommendations` because this is the deferred LLM SAFETY NET (a paid weekly call), gated
// independently of the always-on deterministic linker.
export const recommendationScanConfigSchema = z.object({
  // Master kill-switch for the session-scan backfill. Default ON; set false in policies.yaml
  // to halt the weekly LLM backfill without a restart (the deterministic linker is unaffected).
  enabled: z.boolean().default(true),
  // How far back (days) a session counts as "recent" for the backfill to re-read.
  windowDays: z.number().int().positive().default(14),
  // Per-run cost budget (USD) for the single StructuredOutput extraction call. Verified
  // post-call; output is discarded and the cursor is not advanced on overspend.
  budgetUsd: z.number().nonnegative().default(1.0),
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
    behavior: behaviorConfigSchema.optional(),
    recommendations: recommendationsConfigSchema.optional(),
    recommendationScan: recommendationScanConfigSchema.optional(),
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
    behavior: behaviorConfigSchema.parse(data.behavior ?? {}),
    recommendations: recommendationsConfigSchema.parse(data.recommendations ?? {}),
    recommendationScan: recommendationScanConfigSchema.parse(data.recommendationScan ?? {}),
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

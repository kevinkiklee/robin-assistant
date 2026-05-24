import { z } from 'zod';

export const powerSchema = z.object({
  state: z.enum(['active', 'paused', 'off']).default('active'),
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
  enabled: z.boolean().default(true),
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
    notifications: notificationsSchema.optional(),
    linear: linearConfigSchema.optional(),
    biographer: biographerConfigSchema.optional(),
    agent: agentSchema.optional(),
  })
  .transform((data) => ({
    power: powerSchema.parse(data.power ?? {}),
    capture: captureSchema.parse(data.capture ?? {}),
    network: networkSchema.parse(data.network ?? {}),
    notifications: notificationsSchema.parse(data.notifications ?? {}),
    linear: linearConfigSchema.parse(data.linear ?? {}),
    biographer: biographerConfigSchema.parse(data.biographer ?? {}),
    agent: agentSchema.parse(data.agent ?? {}),
  }));

export type Policies = z.infer<typeof policiesSchema>;

export const providerConfigSchema = z.object({
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

export const modelsSchema = z.object({
  roles: z.record(z.string(), providerConfigSchema).default({}),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;

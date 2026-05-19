import { z } from 'zod';

export const powerSchema = z.object({
  state: z.enum(['active', 'paused', 'off']).default('active'),
  auto: z
    .object({
      on_low_power_mode: z.enum(['active', 'paused']).optional(),
      quiet_hours: z
        .object({
          start: z.string().regex(/^\d{2}:\d{2}$/),
          end: z.string().regex(/^\d{2}:\d{2}$/),
          mode: z.enum(['online', 'local-only', 'offline']).default('local-only'),
        })
        .optional(),
    })
    .default({}),
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

export const policiesSchema = z
  .object({
    power: powerSchema.optional(),
    capture: captureSchema.optional(),
    network: networkSchema.optional(),
  })
  .transform((data) => ({
    power: powerSchema.parse(data.power ?? {}),
    capture: captureSchema.parse(data.capture ?? {}),
    network: networkSchema.parse(data.network ?? {}),
  }));

export type Policies = z.infer<typeof policiesSchema>;

export const providerConfigSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export const modelsSchema = z.object({
  roles: z.record(z.string(), providerConfigSchema).default({}),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;

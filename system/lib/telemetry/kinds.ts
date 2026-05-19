import { z } from 'zod';

export const eventKindSchemas = {
  'daemon.start': z.object({
    version: z.string(),
    profile: z.string().optional(),
  }),
  'daemon.shutdown': z.object({
    reason: z.string(),
    uptime_ms: z.number().int(),
  }),
  'scheduler.tick': z.object({
    jobs_claimed: z.number().int(),
    jobs_completed: z.number().int(),
    jobs_errored: z.number().int(),
  }),
  'job.run': z.object({
    job_name: z.string(),
    trigger_kind: z.string(),
  }),
  'invariant.check': z.object({
    name: z.string(),
    ok: z.boolean(),
    message: z.string().optional(),
  }),
} as const;

export type EventKind = keyof typeof eventKindSchemas;
export type EventPayload<K extends EventKind> = z.infer<(typeof eventKindSchemas)[K]>;

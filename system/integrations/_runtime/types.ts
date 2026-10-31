import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { IngestInput, IngestResult } from '../../brain/memory/ingest.ts';
import type { CheckOutboundInput, DiscretionDecision } from '../../lib/discretion/policy.ts';

export interface IntegrationManifest {
  name: string;
  version: string;
  schedule?: string;
  /** IANA timezone the schedule is interpreted in. Defaults to ROBIN_TZ env or system TZ. */
  tz?: string;
  cpu_intensive?: boolean;
  permissions?: {
    memory?: { read?: boolean; write?: boolean; namespaces?: string[] };
    network?: string[];
    secrets?: string[];
  };
}

export interface TickResult {
  status: 'ok' | 'skipped' | 'error';
  ingested?: number;
  message?: string;
  /** Streams that failed inside an otherwise-ok tick (e.g. whoop 'recovery'). */
  degraded?: string[];
}

export interface IntegrationContext {
  db: RobinDb;
  llm: LLMDispatcher | null;
  state: KvStore;
  log: Logger;
  fetch: typeof fetch;
  now: () => Date;
  /**
   * How this tick was invoked. 'schedule' = the daemon's cron fired it;
   * 'manual' (default) = an explicit run (MCP `run` action, CLI, tests).
   * Lets integrations with expensive side effects (WHOOP's single-use
   * refresh-token spend) defer a scheduled tick when a manual sync already
   * covered the window, without ever short-circuiting an explicit request.
   */
  trigger?: 'schedule' | 'manual';
  /** Write an event (and optional content/embedding) to the firehose. Decouples extensions from system memory internals. */
  ingest: (input: IngestInput) => Promise<IngestResult>;
  /** Pre-flight discretion check for outbound writes (Discord reply, spotify_write, etc.). Refuses on PII shapes (credit card with Luhn / SSN / SIN) and credential shapes (OpenAI / Anthropic / GitHub / AWS / Google / Slack / Stripe). Trusted-origin shortcut skips the (future) verbatim-quote layer but PII + secret guards always apply. */
  checkOutbound: (input: CheckOutboundInput) => DiscretionDecision;
}

export interface Integration {
  init?: (ctx: IntegrationContext) => Promise<void> | void;
  tick?: (ctx: IntegrationContext) => Promise<TickResult> | TickResult;
  cleanup?: (ctx: IntegrationContext) => Promise<void> | void;
  health?: (
    ctx: IntegrationContext,
  ) => Promise<{ ok: boolean; message?: string }> | { ok: boolean; message?: string };
}

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  /**
   * Acquire a cross-process lease under `key` for `ttlMs`, atomically. Returns
   * true if granted (no live lease held), false otherwise. Backed by a
   * conditional UPSERT on `integration_state`, so it coordinates across
   * separate processes (daemon, MCP servers) sharing the DB file. Optional:
   * ad-hoc/in-memory stores may omit it, in which case callers fall back to
   * lock-free behavior.
   */
  acquireLock?(key: string, ttlMs: number, nowMs: number): boolean;
  /** Release a lease acquired via {@link acquireLock}. */
  releaseLock?(key: string): void;
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

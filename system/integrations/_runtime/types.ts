import type { RobinDb } from '../../brain/memory/db.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';

export interface IntegrationManifest {
  name: string;
  version: string;
  schedule?: string;
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
}

export interface IntegrationContext {
  db: RobinDb;
  llm: LLMDispatcher | null;
  state: KvStore;
  log: Logger;
  fetch: typeof fetch;
  now: () => Date;
}

export interface Integration {
  init?: (ctx: IntegrationContext) => Promise<void> | void;
  tick?: (ctx: IntegrationContext) => Promise<TickResult> | TickResult;
  cleanup?: (ctx: IntegrationContext) => Promise<void> | void;
  health?: (ctx: IntegrationContext) => Promise<{ ok: boolean; message?: string }> | { ok: boolean; message?: string };
}

export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

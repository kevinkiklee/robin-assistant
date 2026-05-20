import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { IngestInput, IngestResult } from '../../brain/memory/ingest.ts';

export interface JobManifest {
  name: string;
  version: string;
  /** Cron expression, or 'manual' for jobs only run via CLI / explicit trigger. */
  schedule?: string;
  description?: string;
  permissions?: {
    memory?: { read?: boolean; write?: boolean; namespaces?: string[] };
    network?: string[];
    secrets?: string[];
  };
}

export interface JobResult {
  status: 'ok' | 'skipped' | 'error';
  message?: string;
  eventId?: number;
}

export interface JobContext {
  db: RobinDb;
  llm: LLMDispatcher | null;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  fetch: typeof fetch;
  now: () => Date;
  ingest: (input: IngestInput) => Promise<IngestResult>;
  /** Absolute path to the job's own directory (so the job can read sibling files like prompt.md). */
  rootDir: string;
}

export interface Job {
  run: (ctx: JobContext) => Promise<JobResult> | JobResult;
}

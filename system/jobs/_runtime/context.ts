import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { checkOutbound } from '../../lib/discretion/policy.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import type { JobContext } from './types.ts';

export function buildJobContext(
  jobName: string,
  rootDir: string,
  db: RobinDb,
  llm: LLMDispatcher | null,
  options?: { force?: boolean },
): JobContext {
  const pinoLog = createLogger({ module: `job:${jobName}` });
  return {
    db,
    llm,
    log: {
      info: (obj, msg) => pinoLog.info(obj, msg),
      warn: (obj, msg) => pinoLog.warn(obj, msg),
      error: (obj, msg) => pinoLog.error(obj, msg),
    },
    fetch,
    now: () => new Date(),
    // ingest is now sync but the context contract is async — existing jobs await this
    // call (and jobs may want to chain real async work after), so wrap in Promise.resolve.
    ingest: (input) => Promise.resolve(ingest(db, llm, input)),
    checkOutbound,
    rootDir,
    force: options?.force ?? false,
  };
}

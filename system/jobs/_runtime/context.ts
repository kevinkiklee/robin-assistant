import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import type { JobContext } from './types.ts';

export function buildJobContext(
  jobName: string,
  rootDir: string,
  db: RobinDb,
  llm: LLMDispatcher | null,
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
    ingest: (input) => ingest(db, llm, input),
    rootDir,
  };
}

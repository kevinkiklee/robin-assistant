import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { createKvStore } from './kv.ts';
import type { IntegrationContext } from './types.ts';

export function buildContext(
  integrationName: string,
  db: RobinDb,
  llm: LLMDispatcher | null,
): IntegrationContext {
  const pinoLog = createLogger({ module: `integration:${integrationName}` });
  return {
    db,
    llm,
    state: createKvStore(db, integrationName),
    log: {
      info: (obj, msg) => pinoLog.info(obj, msg),
      warn: (obj, msg) => pinoLog.warn(obj, msg),
      error: (obj, msg) => pinoLog.error(obj, msg),
    },
    fetch: fetch,
    now: () => new Date(),
  };
}

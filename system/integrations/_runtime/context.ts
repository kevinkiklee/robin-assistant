import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { checkOutbound } from '../../lib/discretion/policy.ts';
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
    // ingest is now sync but the context contract is async — existing extensions
    // await this call, so wrap in a resolved promise rather than breaking that shape.
    ingest: (input) => Promise.resolve(ingest(db, llm, input)),
    checkOutbound,
  };
}

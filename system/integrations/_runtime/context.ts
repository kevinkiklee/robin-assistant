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
    //
    // Extension-kind normalization: the v2-derived extensions consistently pass
    // `kind: "integration.tick"` to ctx.ingest while putting the real content kind
    // in `payload.kind` (e.g. "spotify_top_artist", "recovery"). That flattens the
    // firehose — every captured event ends up under one kind and recall can't filter
    // by source/content. When we see that shape, rewrite the event-row kind to
    // `<integration>.<payload.kind>` so it's source-prefixed (avoids future
    // collisions between e.g. whoop.cycle and strava.cycle) and queryable.
    //
    // If payload.kind already starts with the integration name (some extensions write
    // "spotify_top_artist") we accept that as-is rather than double-prefixing.
    ingest: (input) => {
      const payloadKind = (input.payload as { kind?: unknown } | undefined)?.kind;
      if (input.kind === 'integration.tick' && typeof payloadKind === 'string' && payloadKind) {
        const prefix = `${integrationName}.`;
        const promoted = payloadKind.startsWith(integrationName)
          ? payloadKind
          : `${prefix}${payloadKind}`;
        input = { ...input, kind: promoted };
      }
      return Promise.resolve(ingest(db, llm, input));
    },
    checkOutbound,
  };
}

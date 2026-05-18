// Trigger tick loop. One tick: read events strictly after the persisted
// cursor, dispatch each through the engine, advance the cursor to the last
// processed event.
//
// Designed to be wired in as a heartbeat-bucket tick rather than its own
// timer, so it inherits scheduler shutdown drain semantics automatically.

import {
  fetchEventsAfter,
  lookupLastFire,
  readTriggerCursor,
  recordTriggerFire,
  writeTriggerCursor,
} from './persistence.js';

/**
 * Build a tick function suitable for createScheduler({ buckets: [{ tick }] }).
 *
 * deps:
 *   db         — surreal client
 *   engine     — createTriggerEngine() result
 *   dispatchTool — async (name, args, opts) => any. Resolves tool name to handler.
 *   batchSize  — events per tick (default 100)
 *   logger     — console-like; warn/error only used
 */
export function createTriggerTick({
  db,
  engine,
  dispatchTool,
  batchSize = 100,
  logger = console,
} = {}) {
  if (!db) throw new Error('createTriggerTick: db is required');
  if (!engine) throw new Error('createTriggerTick: engine is required');
  if (typeof dispatchTool !== 'function') {
    throw new Error('createTriggerTick: dispatchTool function is required');
  }

  return async function tick() {
    if (engine.list().length === 0) return { processed: 0, fired: 0 };

    let cursor;
    try {
      cursor = await readTriggerCursor(db);
    } catch (e) {
      logger.warn?.(`[triggers] readTriggerCursor failed: ${e?.message ?? e}`);
      return { processed: 0, fired: 0, error: String(e?.message ?? e) };
    }

    let events;
    try {
      events = await fetchEventsAfter(db, cursor, { limit: batchSize });
    } catch (e) {
      logger.warn?.(`[triggers] fetchEventsAfter failed: ${e?.message ?? e}`);
      return { processed: 0, fired: 0, error: String(e?.message ?? e) };
    }

    if (!events.length) return { processed: 0, fired: 0 };

    let fired = 0;
    let lastTs = cursor.last_event_ts;
    let lastId = cursor.last_event_id;
    let processed = 0;

    for (const ev of events) {
      try {
        const result = await engine.processEvent({
          event: normalizeEvent(ev),
          dispatchTool,
          lookupLastFire: (name) => lookupLastFire(db, name),
          recordFire: (rec) =>
            recordTriggerFire(db, rec).catch((e) => {
              logger.warn?.(
                `[triggers] recordTriggerFire failed for ${rec.name}: ${e?.message ?? e}`,
              );
            }),
        });
        fired += result.fired ?? 0;
      } catch (e) {
        logger.error?.(`[triggers] processEvent threw for event ${ev.id}: ${e?.message ?? e}`);
        // Continue to next event — one bad event must not block the cursor.
      }
      processed += 1;
      lastTs = ev.ts ?? lastTs;
      lastId = stripEventPrefix(ev.id) ?? lastId;
    }

    try {
      await writeTriggerCursor(db, { last_event_ts: lastTs, last_event_id: lastId });
    } catch (e) {
      logger.warn?.(`[triggers] writeTriggerCursor failed: ${e?.message ?? e}`);
    }

    return { processed, fired };
  };
}

function normalizeEvent(ev) {
  // SurrealDB RecordId comes back as object with toString(); engine expects
  // event.id as something printable. Strip "events:" prefix for stable IDs.
  return {
    ...ev,
    id: stripEventPrefix(ev.id),
  };
}

function stripEventPrefix(rid) {
  if (rid == null) return null;
  const s = typeof rid === 'string' ? rid : String(rid);
  return s.startsWith('events:') ? s.slice('events:'.length) : s;
}

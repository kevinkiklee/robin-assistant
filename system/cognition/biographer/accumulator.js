// accumulator.js — windowed source-bucketed batch accumulator.
//
// Sits between queueWrap.enqueue and the biographer worker. Three triggers:
//   - count: max_batch_size hit → fire immediately
//   - debounce: debounce_ms of silence on this bucket → fire
//   - hard cap: max_wait_ms since first event in this bucket → fire even under
//     sustained input
//
// Per-source buckets so CLI / Discord / ingest don't mix in one LLM call.
// When a bucket is fired the accumulator opens a fresh bucket for that source
// while the in-flight one awaits its fire() handler. The underlying queue is
// expected to serialise fired batches globally (see §1, §7 in the spec).

export function createBatchAccumulator({ config, fire }) {
  if (typeof config !== 'function')
    throw new Error('createBatchAccumulator: config must be a function');
  if (typeof fire !== 'function')
    throw new Error('createBatchAccumulator: fire must be a function');

  // source -> { ids: string[], firstEnqueuedAt: number, debounceTimer, capTimer }
  const buckets = new Map();

  function clearTimers(b) {
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    if (b.capTimer) clearTimeout(b.capTimer);
    b.debounceTimer = null;
    b.capTimer = null;
  }

  function flush(source) {
    const b = buckets.get(source);
    if (!b || b.ids.length === 0) return;
    clearTimers(b);
    const ids = b.ids;
    // Open a fresh bucket immediately — new adds for this source while the
    // fired batch is in-flight go into the new bucket.
    buckets.delete(source);
    // fire returns a promise; we don't await — the queue serialises.
    Promise.resolve()
      .then(() => fire(ids, source))
      .catch((e) => {
        // Surface but don't crash the accumulator.
        console.warn(`[biographer accumulator] fire failed for source=${source}: ${e.message}`);
      });
  }

  function add(eventId, source) {
    if (!eventId) throw new Error('accumulator.add: eventId required');
    if (!source) throw new Error('accumulator.add: source required');
    const cfg = config();
    const maxBatch = cfg.max_batch_size ?? 8;
    const debounceMs = cfg.debounce_ms ?? 750;
    const maxWaitMs = cfg.max_wait_ms ?? 3000;

    // Disable bypass (spec §9): short-circuit the bucket/timer entirely so
    // events flow straight to fire() one at a time. Used as the operator
    // rollback lever — restores pre-C1 behaviour byte-for-byte.
    if (cfg.disable === true) {
      Promise.resolve()
        .then(() => fire([String(eventId)], source))
        .catch((e) => {
          console.warn(`[biographer accumulator] fire (disabled mode) failed: ${e.message}`);
        });
      return;
    }

    let b = buckets.get(source);
    if (!b) {
      b = {
        ids: [],
        seen: new Set(),
        firstEnqueuedAt: Date.now(),
        debounceTimer: null,
        capTimer: null,
      };
      buckets.set(source, b);
      b.capTimer = setTimeout(() => flush(source), maxWaitMs);
    }
    // Dedupe within the bucket. Concurrent capture paths (Discord adapter,
    // /internal/biographer/process-pending, and remember tool) can each call
    // add() for the same event id while the bucket is still open. Without
    // this guard the bucket ships duplicates to biographerProcessBatch,
    // which then chains self-loop `before` edges between the duplicates and
    // logs "biographer race detected on 1/N events" on every batch.
    const idStr = String(eventId);
    if (b.seen.has(idStr)) return;
    b.seen.add(idStr);
    b.ids.push(idStr);
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    b.debounceTimer = setTimeout(() => flush(source), debounceMs);
    if (b.ids.length >= maxBatch) {
      flush(source);
    }
  }

  return { add };
}

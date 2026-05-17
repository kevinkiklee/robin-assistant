// faculty.js — introspection faculty lifecycle (Phase 1).
//
// Sister to intuition, biographer, reflection, reinforcement, dream.
// Always-on daemon component that polls task_close_queue on a 1-min tick,
// runs structural outcome inference (no LLM in Phase 1), and writes
// task_outcome memos.
//
// Lifecycle:
//   startIntrospection({ db })  → starts the drain loop
//   stopIntrospection()         → stops the drain loop (bounded 20s drain)
//
// Gate: runtime:self-improvement-v2.value.enabled (default false).
// When false, start() is a no-op — the faculty exists but queue is not drained.
//
// Crash isolation:
//   - Per-row try/catch in queue-poller.js.
//   - Faculty-level unhandledRejection handler increments crash_count.
//   - Leaky-bucket decay: 1 decrement per minute.
//   - Auto-restart when crash_count > INTROSPECTION_DEFAULTS.crash_count_restart_threshold.
//
// Timer rules (CLAUDE.md):
//   - setInterval MUST be paired with .unref() AND clearInterval in stop().
//   - Leaky-bucket decay timer MUST have .unref().

import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import {
  decrementCrashCount,
  incrementCrashCount,
  initBudgetConfig,
  readBudgetState,
} from './budget.js';
import { INTROSPECTION_DEFAULTS } from './inference-rules.js';
import { drainQueueOnce } from './queue-poller.js';

const DRAIN_INTERVAL_MS = 60_000;
const DRAIN_WALL_CLOCK_MS = 20_000;
const DECAY_INTERVAL_MS = 60_000; // 1 decrement/min → 1/60 per second

/** @type {{ db: object, drainTimer: any, decayTimer: any, rejectionHandler: Function } | null} */
let _state = null;

/**
 * Start the introspection faculty.
 *
 * @param {{ db: object }} options
 */
export async function startIntrospection({ db }) {
  if (_state) {
    // Already running — no-op (idempotent start).
    return;
  }

  // Gate: if self-improvement-v2 is not enabled, faculty is present but
  // doesn't drain the queue.  Check once at start; hot-reload picks up
  // changes on the next daemon restart (same pattern as state-inference).
  const enabled = await isSelfImprovementV2Enabled(db).catch(() => false);
  if (!enabled) {
    console.log(
      '[introspection] self-improvement-v2 not enabled — faculty started (drain suppressed)',
    );
    // Install a minimal state so stopIntrospection() is a no-op rather than
    // throwing. No timers needed when gated off.
    _state = { db, drainTimer: null, decayTimer: null, rejectionHandler: null };
    return;
  }

  // Ensure budget config KV row exists.
  try {
    await initBudgetConfig(db);
  } catch (e) {
    console.warn(`[introspection] initBudgetConfig failed (non-fatal): ${e.message}`);
  }

  // Faculty-level unhandledRejection handler.
  // Routes introspection-tagged errors into the faculty logger and increments
  // the leaky-bucket crash counter.  Tagged by source file path.
  const rejectionHandler = (reason) => {
    const stack = reason?.stack ?? '';
    if (stack.includes('/cognition/introspection/') || reason?._introspection === true) {
      console.warn(`[introspection] unhandled rejection: ${reason?.message ?? reason}`);
      incrementCrashCount(db).catch(() => {});
      _checkCrashCountAndRestart(db);
    }
  };
  process.on('unhandledRejection', rejectionHandler);

  // Drain loop — 1-min tick.
  const drainTimer = setInterval(async () => {
    try {
      const { processed, written, errors } = await _drainWithTimeout(db);
      if (processed > 0) {
        console.log(
          `[introspection] drain: processed=${processed} written=${written} errors=${errors}`,
        );
      }
    } catch (e) {
      console.warn(`[introspection] drain tick failed: ${e.message}`);
      incrementCrashCount(db).catch(() => {});
    }
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref?.();

  // Leaky-bucket decay — 1 decrement per minute.
  const decayTimer = setInterval(() => {
    decrementCrashCount(db).catch(() => {});
  }, DECAY_INTERVAL_MS);
  decayTimer.unref?.();

  _state = { db, drainTimer, decayTimer, rejectionHandler };
  console.log('[introspection] faculty started (self-improvement-v2 enabled)');
}

/**
 * Stop the introspection faculty.
 * Clears timers and removes the unhandledRejection handler.
 * No-op if faculty was never started or already stopped.
 */
export async function stopIntrospection() {
  if (!_state) return;
  const { drainTimer, decayTimer, rejectionHandler } = _state;

  if (drainTimer) clearInterval(drainTimer);
  if (decayTimer) clearInterval(decayTimer);
  if (rejectionHandler) process.off('unhandledRejection', rejectionHandler);

  _state = null;
  console.log('[introspection] faculty stopped');
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Run drainQueueOnce with a wall-clock cap (DRAIN_WALL_CLOCK_MS).
 * Unfinished grades stay in queue for the next tick.
 */
async function _drainWithTimeout(db) {
  return Promise.race([
    drainQueueOnce(db),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('drain wall-clock cap exceeded')),
        DRAIN_WALL_CLOCK_MS,
      ).unref(),
    ),
  ]);
}

/**
 * Auto-restart the drain loop if crash_count exceeds threshold.
 * Called after every crash increment.  Reads the state asynchronously.
 */
async function _checkCrashCountAndRestart(db) {
  try {
    const state = await readBudgetState(db);
    if (state.crash_count > INTROSPECTION_DEFAULTS.crash_count_restart_threshold) {
      console.warn(
        `[introspection] crash_count=${state.crash_count} > threshold=${INTROSPECTION_DEFAULTS.crash_count_restart_threshold} — restarting faculty`,
      );
      await stopIntrospection();
      // Brief pause before restart to avoid tight loops.
      await new Promise((r) => setTimeout(r, 1000).unref());
      await startIntrospection({ db });
    }
  } catch (e) {
    console.warn(`[introspection] crash-count restart check failed: ${e.message}`);
  }
}

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
  autoTuneTurnSamplePct,
  decrementCrashCount,
  incrementCrashCount,
  initBudgetConfig,
  readBudgetConfig,
  readBudgetState,
  resetCrashCount,
} from './budget.js';
import { INTROSPECTION_DEFAULTS } from './inference-rules.js';
import { drainQueueOnce } from './queue-poller.js';

const DRAIN_INTERVAL_MS = 60_000;
const DRAIN_WALL_CLOCK_MS = 20_000;
const DECAY_INTERVAL_MS = 60_000; // 1 decrement/min → 1/60 per second
const AUTOTUNE_INTERVAL_MS = 60 * 60_000; // recompute turn_sample_pct hourly

/** @type {{ db: object, host: object|null, drainTimer: any, decayTimer: any, autoTuneTimer: any, rejectionHandler: Function } | null} */
let _state = null;

// Guard flag — prevents fire-and-forget restart re-entry when crash_count
// is high enough to trigger the threshold on multiple consecutive ticks.
let _restarting = false;

/**
 * Start the introspection faculty.
 *
 * @param {{ db: object, host?: object|null }} options
 *   host — optional HostAdapter with invokeLLM for inline LLM grading (Wave 3).
 *           When null/absent, only structural inference runs.
 */
export async function startIntrospection({ db, host = null }) {
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
    _state = { db, host: null, drainTimer: null, decayTimer: null, autoTuneTimer: null, rejectionHandler: null };
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
      const { processed, written, errors, graded } = await _drainWithTimeout(db, host);
      if (processed > 0) {
        console.log(
          `[introspection] drain: processed=${processed} written=${written} errors=${errors} graded=${graded ?? 0}`,
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

  // Auto-tune turn_sample_pct hourly (spec §2 "turn_sample_pct auto-tune").
  // Fire once immediately (cold-start init), then on the hourly interval.
  const _runAutoTune = () => {
    readBudgetConfig(db)
      .then((cfg) => autoTuneTurnSamplePct(db, cfg))
      .catch((e) => console.warn(`[introspection] auto-tune failed: ${e.message}`));
  };
  _runAutoTune(); // immediate boot-time run
  const autoTuneTimer = setInterval(_runAutoTune, AUTOTUNE_INTERVAL_MS);
  autoTuneTimer.unref?.();

  _state = { db, host, drainTimer, decayTimer, autoTuneTimer, rejectionHandler };
  console.log(
    `[introspection] faculty started (self-improvement-v2 enabled, host=${host ? 'present' : 'absent'})`,
  );
}

/**
 * Stop the introspection faculty.
 * Clears timers and removes the unhandledRejection handler.
 * No-op if faculty was never started or already stopped.
 */
export async function stopIntrospection() {
  if (!_state) return;
  const { drainTimer, decayTimer, autoTuneTimer, rejectionHandler } = _state;

  if (drainTimer) clearInterval(drainTimer);
  if (decayTimer) clearInterval(decayTimer);
  if (autoTuneTimer) clearInterval(autoTuneTimer);
  if (rejectionHandler) process.off('unhandledRejection', rejectionHandler);

  _state = null;
  console.log('[introspection] faculty stopped');
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Run drainQueueOnce with a wall-clock cap (DRAIN_WALL_CLOCK_MS).
 * Unfinished grades stay in queue for the next tick.
 */
async function _drainWithTimeout(db, host) {
  return Promise.race([
    drainQueueOnce(db, host),
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
 *
 * Guards against re-entry: if a restart is already in progress (e.g. the
 * leaky-bucket fires again before the restart completes), this is a no-op.
 * Also resets crash_count to 0 before restarting so the bucket doesn't
 * immediately re-trigger on the next increment.
 */
async function _checkCrashCountAndRestart(db) {
  if (_restarting) return;
  try {
    const state = await readBudgetState(db);
    if (state.crash_count > INTROSPECTION_DEFAULTS.crash_count_restart_threshold) {
      _restarting = true;
      console.warn(
        `[introspection] crash_count=${state.crash_count} > threshold=${INTROSPECTION_DEFAULTS.crash_count_restart_threshold} — restarting faculty`,
      );
      // Reset crash_count to 0 before restart so the leaky-bucket can't
      // immediately re-trigger on the next unhandledRejection increment.
      await resetCrashCount(db).catch(() => {});
      await stopIntrospection();
      // Brief pause before restart to avoid tight loops.
      await new Promise((r) => setTimeout(r, 1000).unref());
      _restarting = false;
      await startIntrospection({ db });
    }
  } catch (e) {
    _restarting = false;
    console.warn(`[introspection] crash-count restart check failed: ${e.message}`);
  }
}

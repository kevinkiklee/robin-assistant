// Helper for the hook-enforcement-review protocol (Dream Phase 3 step 11.6).
//
// Parses the JSONL telemetry written by the pre-protocol-override hook,
// filters by `since` (last_dream_at watermark), and aggregates by event type.
// Returns a structured summary the protocol uses to write corrections.md /
// dream-state.md / learning-queue.md notes.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOG_REL = 'user-data/runtime/state/telemetry/protocol-override-enforcement.log';
const BLOCK_THRESHOLD = 2;
const HOOK_ERROR_REPEAT_THRESHOLD = 3;

export function loadTelemetryEntries(workspace, sinceISO = null) {
  const path = join(workspace, LOG_REL);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const out = [];
  const sinceMs = sinceISO ? Date.parse(sinceISO) : null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceMs !== null) {
      const ts = Date.parse(entry.ts);
      if (Number.isNaN(ts) || ts <= sinceMs) continue;
    }
    out.push(entry);
  }
  return out;
}

// Returns:
//   {
//     blocks_by_protocol: { [protocol]: { count, timestamps[] } },
//     recurring_blocks:   [protocol]                               // count >= BLOCK_THRESHOLD
//     hook_errors:        [{ ts, mode, error_class, message }]     // raw list
//     repeated_error_classes: [{ error_class, count }]             // count >= HOOK_ERROR_REPEAT_THRESHOLD
//     injected_count:     int
//     blocked_count:      int
//   }
export function aggregate(entries) {
  const blocks = new Map();
  const errors = [];
  const errorClassCounts = new Map();
  let injected = 0;
  let blocked = 0;
  for (const e of entries) {
    if (e.event === 'injected') {
      injected += 1;
    } else if (e.event === 'blocked') {
      blocked += 1;
      const p = e.protocol;
      if (!p) continue;
      if (!blocks.has(p)) blocks.set(p, { count: 0, timestamps: [] });
      const slot = blocks.get(p);
      slot.count += 1;
      slot.timestamps.push(e.ts);
    } else if (e.event === 'hook_error') {
      errors.push({
        ts: e.ts,
        mode: e.mode ?? null,
        error_class: e.error_class ?? null,
        message: e.message ?? '',
      });
      const cls = e.error_class ?? 'unknown';
      errorClassCounts.set(cls, (errorClassCounts.get(cls) ?? 0) + 1);
    }
  }
  const recurring = [];
  for (const [p, slot] of blocks) {
    if (slot.count >= BLOCK_THRESHOLD) recurring.push(p);
  }
  const repeatedErrors = [];
  for (const [cls, count] of errorClassCounts) {
    if (count >= HOOK_ERROR_REPEAT_THRESHOLD) repeatedErrors.push({ error_class: cls, count });
  }
  return {
    blocks_by_protocol: Object.fromEntries(blocks),
    recurring_blocks: recurring.sort(),
    hook_errors: errors,
    repeated_error_classes: repeatedErrors.sort((a, b) => a.error_class.localeCompare(b.error_class)),
    injected_count: injected,
    blocked_count: blocked,
  };
}

export function buildCorrectionsNote(protocol, slot) {
  return [
    `- [correction|origin=derived] Hook recurring miss: ${protocol} blocked ${slot.count} times since last dream (${slot.timestamps.join(', ')}).`,
    `  Hook is enforcing but model still attempts the wrong file — investigate whether the injection text needs to be louder or whether this signals model drift.`,
  ].join('\n');
}

export function buildLearningQueueNote(errorClass, count) {
  return `- [investigate] Hook error class \`${errorClass}\` repeated ${count} times since last dream — investigate the hook itself.`;
}

export function buildSummary(agg) {
  return `Hook review: ${agg.blocked_count} blocks aggregated for ${agg.recurring_blocks.length} protocols, ${agg.hook_errors.length} hook_errors notable.`;
}

export const THRESHOLDS = {
  BLOCK: BLOCK_THRESHOLD,
  HOOK_ERROR_REPEAT: HOOK_ERROR_REPEAT_THRESHOLD,
};

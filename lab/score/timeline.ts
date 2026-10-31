// lab/score/timeline.ts
//
// The belief head timeline of one copy snapshot, classified against the script:
// which slot and value each belief.update record asserts, and which write route
// produced it.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTopic } from '../../system/brain/memory/belief.ts';
import { closeDb, openDb, type RobinDb } from '../../system/brain/memory/db.ts';
import { type HeadCaptureRow, readHeadRows } from '../copy/heads.ts';
import { parseClaim } from '../render/grammar.ts';
import type { Script } from '../script/types.ts';

export interface HeadRecord {
  eventId: number;
  topic: string;
  /** Earliest ts this (eventId, claim) was seen with: when the claim was written. */
  tsMs: number;
  /**
   * Ordering time: tsMs, raised to the previous claim of the same event row when a later
   * capture shows an overwrite stamped earlier (the sim clock restarts each copy-day at
   * the day's first event, which can precede the previous night's 03:50 dream). Overwrites
   * share a local date, so this never moves a record across a day boundary.
   */
  orderMs: number;
  /** First-seen order across captures; breaks orderMs ties within one event row. */
  seq: number;
  claim: string;
  retracted: boolean;
  /** parseClaim(claim).label → normalizeTopic, when that is a script slot. */
  slot: string | null;
  value: string | null;
  route: 'direct-believe' | 'correction-believe' | 'promotion' | 'other';
}

const byTime = (a: HeadRecord, b: HeadRecord) =>
  a.orderMs - b.orderMs || a.eventId - b.eventId || a.seq - b.seq;

/** Run `fn` against a throwaway copy of the snapshot: recall may write, the snapshot never changes. */
export function withSnapshotCopy<T>(snapshotPath: string, fn: (db: RobinDb) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'lab-score-'));
  const copy = join(dir, 'snapshot.sqlite');
  copyFileSync(snapshotPath, copy);
  const db = openDb(copy);
  try {
    return fn(db);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every belief.update record, classified against the script: the union of the daily head
 * captures (oldest first) and the snapshot, keyed by (eventId, claim) with the earliest ts
 * seen. A claim overwritten by a same-day upsert survives with its own route: 'promotion'
 * when its sources were non-empty when captured, else the route ledger's, else 'other'.
 * (A claim that returns to an earlier claim of the same row keeps the earlier position.)
 * Works on a temp copy of the snapshot.
 */
export function readHeadTimeline(
  snapshotPath: string,
  script: Script,
  routes: Map<number, string>,
  captures: HeadCaptureRow[][] = [],
): HeadRecord[] {
  const slots = new Set(script.slots.map((s) => s.key));
  const final = withSnapshotCopy(snapshotPath, readHeadRows);
  const byKey = new Map<string, HeadRecord>();
  let seq = 0;
  for (const rows of [...captures, final]) {
    for (const b of rows) {
      const key = `${b.eventId}\u0000${b.claim}`;
      const tsMs = Date.parse(b.ts);
      const prior = byKey.get(key);
      if (prior) {
        if (tsMs < prior.tsMs) prior.tsMs = tsMs;
        continue;
      }
      const parsed = parseClaim(b.claim);
      const slotKey = parsed ? normalizeTopic(parsed.label) : null;
      const slot = slotKey !== null && slots.has(slotKey) ? slotKey : null;
      const hit = routes.get(b.eventId);
      byKey.set(key, {
        eventId: b.eventId,
        topic: b.topic,
        tsMs,
        orderMs: tsMs,
        seq: seq++,
        claim: b.claim,
        retracted: b.retracted,
        slot,
        value: slot !== null && parsed ? parsed.value : null,
        route: b.sources
          ? 'promotion'
          : hit === 'direct-believe' || hit === 'correction-believe'
            ? hit
            : 'other',
      });
    }
  }
  // Within one event row, a later claim never orders before the claim it overwrote.
  const byEvent = new Map<number, HeadRecord[]>();
  for (const r of byKey.values()) {
    const list = byEvent.get(r.eventId) ?? [];
    list.push(r);
    byEvent.set(r.eventId, list);
  }
  for (const list of byEvent.values()) {
    list.sort((a, b) => a.seq - b.seq);
    let floor = Number.NEGATIVE_INFINITY;
    for (const r of list) {
      r.orderMs = Math.max(r.tsMs, floor);
      floor = r.orderMs;
    }
  }
  return [...byKey.values()].sort(byTime);
}

/**
 * The current non-retracted head of every topic at instant `tMs`, slot or not. A
 * cross-topic supersede leaves the old topic's head live — this mirrors production,
 * which enumerates heads per topic the same way.
 */
export function headsAt(records: HeadRecord[], tMs: number): HeadRecord[] {
  const head = new Map<string, HeadRecord>();
  for (const r of records) {
    if (r.orderMs > tMs) continue;
    const cur = head.get(r.topic);
    if (!cur || byTime(cur, r) < 0) head.set(r.topic, r);
  }
  return [...head.values()].filter((r) => !r.retracted);
}

/** Values asserted for each slot at instant `tMs` (current non-retracted head per topic, grouped by slot). */
export function assertedAt(records: HeadRecord[], tMs: number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of headsAt(records, tMs)) {
    if (r.slot === null || r.value === null) continue;
    const set = out.get(r.slot) ?? new Set<string>();
    set.add(r.value);
    out.set(r.slot, set);
  }
  return out;
}

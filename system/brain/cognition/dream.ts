import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { levenshtein } from '../../lib/levenshtein.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { applyCorrections } from '../learning/apply-corrections.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import {
  countPendingCandidates,
  expireStaleCandidates,
  resolveBeliefCandidate,
} from '../memory/belief-candidate.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBeliefFreshness } from './belief-freshness.ts';
import { runHygiene } from './hygiene.ts';
import { ingestContentDocs } from './ingest-docs.ts';

export interface DreamResult {
  predictionsResolved: number;
  brierDeltaSum: number;
  journalGenerated: boolean;
  entitiesSummarized: number;
  arcsCreated: number;
  candidatesExpired: number;
  staleFlagsRaised: number;
  /** Stale belief heads flagged with a belief.stale event this run. */
  staleBeliefsFlagged: number;
  /** Stale belief heads successfully re-verified via a registered resolver. */
  beliefsRefreshed: number;
  /** content/* docs ingested or updated into events_content for recall this run. */
  docsIngested: number;
  /** Topic-linked corrections processed (applied=1) this run. */
  correctionsApplied: number;
  /** Belief heads retracted due to a topic-linked correction this run. */
  beliefsRetracted: number;
  /** Pending candidates auto-promoted to held beliefs this run. */
  candidatesPromoted: number;
  /** Candidates flagged as conflicting with an existing belief head. */
  candidatesConflicted: number;
  /** Near-duplicate candidates merged (lower-confidence one resolved). */
  candidatesMerged: number;
  /** Non-empty depth synthesis sections appended to the journal. */
  depthInsightsGenerated: number;
  /** Whether a learning digest event was persisted this run. */
  digestGenerated: boolean;
  /** Noise relations deleted by nightly hygiene pass. */
  hygieneRelationsDeleted: number;
  /** Noise entities auto-deleted by nightly hygiene pass. */
  hygieneEntitiesDeleted: number;
  /** Score-based auto-culls by Tier 2 hygiene (subset of hygieneEntitiesDeleted). */
  hygieneEntitiesAutoCulled: number;
  /** New names added to the adaptive noise blocklist. */
  hygieneBlocklistGrown: number;
}

// ── Learning digest types ────────────────────────────────────────────────────

export interface HandlerActivityRow {
  surface: string;
  runs: number;
  cost: number;
  turns: number;
  handlers: string;
}

export interface LearningDigest {
  /** Handler activity summary (last 24h) grouped by surface. */
  handlerActivity: HandlerActivityRow[];
  /** Prediction calibration: resolved counts by outcome. */
  predictionsByOutcome: Array<{ outcome: string; n: number }>;
  /** Overall Brier score (lower = better). null if no resolved predictions with brier_delta. */
  overallBrier: number | null;
  /** Open (unresolved) predictions count and nearest deadline. */
  openPredictions: { count: number; nearestDeadline: string | null };
  /** Belief lifecycle snapshot from this dream run. */
  beliefLifecycle: {
    promoted: number;
    conflicted: number;
    merged: number;
    expired: number;
    pendingCandidates: number;
    activeBeliefHeads: number;
  };
  /** Correction coverage. */
  corrections: {
    total: number;
    behavioral: number;
    topicLinked: number;
    unapplied: number;
  };
  /** Recent agent runs with non-success status (capped, timeout, error). */
  failedRuns: Array<{ surface: string; label: string | null; status: string; ts: string }>;
}

const CANDIDATE_EXPIRY_DAYS = 14;

const ENTITY_SUMMARY_MIN_SIGNALS = 3;
const ENTITY_SUMMARY_MAX_PER_RUN = 25;
const ARC_RECENCY_DAYS = 14;
const ARC_MIN_SHARED_ENTITIES = 2;
const ARC_MIN_EVENTS = 2;
const ARC_JACCARD_MERGE_THRESHOLD = 0.6;

/**
 * Nightly consolidation job:
 * 1. Data hygiene — cleans noise entities/relations + auto-culls borderline ones, grows blocklist
 * 2. Resolves overdue predictions as 'unverifiable'
 * 3. Rolls up daily metric counts
 * 4. Summarizes hot entities (signal_count >= threshold among today's relations)
 * 5. Detects narrative arcs from session.captured events in the last 14 days
 * 6. Writes a deterministic metrics-only journal (the 4:00am dream-synthesis
 *    pass upserts a richer narrative over the same day key later)
 * 7. Expires stale belief candidates (pending > 14 days)
 * 8. Scans live belief heads for staleness; re-queries via registered resolvers
 *    (bounded) or flags with belief.stale events (idempotent)
 * 9. Flags prose docs in content/profile that are older than the newest belief/correction signal
 * 10. Indexes content/* markdown docs for recall (idempotent)
 * 11. Replays topic-linked corrections: retracts contradicted belief heads (P4 close-the-loop)
 * 12. Composes and persists a learning digest
 */
export async function runDream(
  db: RobinDb,
  llm: LLMDispatcher | null,
  now: Date = new Date(),
): Promise<DreamResult> {
  const result: DreamResult = {
    predictionsResolved: 0,
    brierDeltaSum: 0,
    journalGenerated: false,
    entitiesSummarized: 0,
    arcsCreated: 0,
    candidatesExpired: 0,
    staleFlagsRaised: 0,
    staleBeliefsFlagged: 0,
    beliefsRefreshed: 0,
    docsIngested: 0,
    correctionsApplied: 0,
    beliefsRetracted: 0,
    candidatesPromoted: 0,
    candidatesConflicted: 0,
    candidatesMerged: 0,
    depthInsightsGenerated: 0,
    digestGenerated: false,
    hygieneRelationsDeleted: 0,
    hygieneEntitiesDeleted: 0,
    hygieneEntitiesAutoCulled: 0,
    hygieneBlocklistGrown: 0,
  };

  // 1. Data hygiene — clean noise entities/relations and grow the adaptive
  //    blocklist. Tier 2 score-based culls run inline (no human review).
  //    Runs first so downstream steps (entity summarization, arc detection)
  //    work on a clean graph. Best-effort: a hygiene failure must never sink
  //    the rest of the dream pass.
  try {
    const hygiene = runHygiene(db, now);
    result.hygieneRelationsDeleted = hygiene.relationsDeleted;
    result.hygieneEntitiesDeleted = hygiene.entitiesDeleted + hygiene.orphansDeleted;
    result.hygieneEntitiesAutoCulled = hygiene.entitiesAutoCulled;
    result.hygieneBlocklistGrown = hygiene.blocklistGrown;
  } catch {
    // zeroed by initializer
  }

  // 2. Auto-resolve predictions past deadline as 'unverifiable' if not already resolved
  const overdue = db
    .prepare(`
    SELECT id, confidence FROM predictions WHERE outcome IS NULL AND deadline IS NOT NULL AND deadline < ?
  `)
    .all(now.toISOString()) as Array<{ id: number; confidence: number }>;
  const resolveStmt = db.prepare(
    `UPDATE predictions SET outcome = ?, resolved_at = ?, brier_delta = NULL WHERE id = ?`,
  );
  for (const p of overdue) {
    resolveStmt.run('unverifiable', now.toISOString(), p.id);
    result.predictionsResolved++;
  }

  // 3. Metrics rollup for today
  const today = now.toISOString().slice(0, 10);
  const since = `${today}T00:00:00.000Z`;
  const eventsToday = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ts >= ?`).get(since) as { c: number }
  ).c;
  const capturesToday = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'session.captured' AND ts >= ?`)
      .get(since) as { c: number }
  ).c;
  const correctionsToday = (
    db.prepare(`SELECT COUNT(*) AS c FROM corrections WHERE ts >= ?`).get(since) as { c: number }
  ).c;

  const upsertMetric = db.prepare(`
    INSERT INTO metrics_daily (day, metric, value, n)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (day, metric) DO UPDATE SET value=excluded.value, n=excluded.n, computed_at=datetime('now')
  `);
  upsertMetric.run(today, 'events_count', eventsToday, eventsToday);
  upsertMetric.run(today, 'captures_count', capturesToday, capturesToday);
  upsertMetric.run(today, 'corrections_count', correctionsToday, correctionsToday);

  // 4. Entity summarization — regenerate profiles for hot entities
  result.entitiesSummarized = await summarizeHotEntities(db, llm, since);

  // 5. Arc detection — cluster recent captured events by shared entities
  result.arcsCreated = detectArcs(db, now);

  // 6. Expire stale belief candidates. Guarded so an older DB without the
  //    belief_candidates table can't crash the whole dream pass.
  try {
    result.candidatesExpired = expireStaleCandidates(db, CANDIDATE_EXPIRY_DAYS, now);
  } catch {
    result.candidatesExpired = 0;
  }

  // 6b. Belief lifecycle: auto-promote stable candidates, detect contradictions,
  //     merge near-duplicates. Deterministic (no LLM). Guarded like step 5.
  try {
    const lifecycle = promoteStableCandidates(db, now);
    result.candidatesPromoted = lifecycle.promoted;
    result.candidatesConflicted = lifecycle.conflicted;
    result.candidatesMerged = lifecycle.merged;
  } catch {
    result.candidatesPromoted = 0;
    result.candidatesConflicted = 0;
    result.candidatesMerged = 0;
  }

  // 6b-metrics. Persist memory-health counters to metrics_daily so quality is
  //   observable over time WITHOUT a user-facing triage queue (migration 017
  //   deliberately removed the brief's hygiene-review section — Kevin wants the
  //   system self-managing, not human-in-the-loop). These are passive metrics:
  //   queryable on demand, never pushed into the brief. Guarded like 6/6b so a
  //   missing belief_candidates table can't sink the dream pass.
  try {
    upsertMetric.run(
      today,
      'beliefs_promoted',
      result.candidatesPromoted,
      result.candidatesPromoted,
    );
    const pending = countPendingCandidates(db);
    upsertMetric.run(today, 'beliefs_pending', pending, pending);
    upsertMetric.run(
      today,
      'entities_culled',
      result.hygieneEntitiesAutoCulled ?? 0,
      result.hygieneEntitiesAutoCulled ?? 0,
    );
  } catch {
    /* belief_candidates table missing (old DB) — skip metric persistence */
  }

  // 6c. Depth synthesis inputs — deterministic SQL queries. Best-effort:
  //     a failure here yields empty arrays, never sinks the dream pass.
  let depthReplays: DecisionReplay[] = [];
  let depthCalibration: PredictionCalibrationRow[] = [];
  let depthDeadlines: ApproachingDeadline[] = [];
  try {
    depthReplays = queryDecisionReplays(db);
    depthCalibration = queryPredictionCalibration(db);
    depthDeadlines = queryApproachingDeadlines(db, now);
  } catch {
    // leave empty — depth is best-effort
  }

  // 7. Compose journal — deterministic metrics-only block with depth sections.
  //    The 4:00am dream-synthesis pass upserts a richer narrative over this same
  //    day key later; dream.run only guarantees the row exists as a fallback.
  const journal = composeJournal({
    today,
    eventsToday,
    capturesToday,
    correctionsToday,
    predictionsResolved: result.predictionsResolved,
    entitiesSummarized: result.entitiesSummarized,
    arcsCreated: result.arcsCreated,
    decisionReplays: depthReplays,
    predictionCalibration: depthCalibration,
    approachingDeadlines: depthDeadlines,
  });
  db.prepare(`
    INSERT INTO journals (day, body) VALUES (?, ?)
    ON CONFLICT (day) DO UPDATE SET body=excluded.body, generated_at=datetime('now')
  `).run(today, journal);
  result.journalGenerated = true;

  // Count non-empty depth sections for the result.
  let depthSections = 0;
  if (depthReplays.length > 0) depthSections++;
  if (depthCalibration.length > 0) depthSections++;
  if (depthDeadlines.length > 0) depthSections++;
  result.depthInsightsGenerated = depthSections;

  // 8. Belief freshness — scan live belief heads, re-query via registered resolvers
  //    (bounded by maxRequeries) and/or flag stale heads with belief.stale events.
  //    Guarded so a failure here never sinks the rest of the dream pass.
  try {
    const freshness = await runBeliefFreshness(db, llm, { now });
    result.staleBeliefsFlagged = freshness.flagged;
    result.beliefsRefreshed = freshness.requeried;
  } catch {
    result.staleBeliefsFlagged = 0;
    result.beliefsRefreshed = 0;
  }

  // 9. Narrative staleness flags — prose docs older than the newest belief/correction signal.
  result.staleFlagsRaised = flagStaleNarrativeDocs(db, now);

  // 10. Keep content/* markdown docs indexed for recall. Idempotent — unchanged files
  //    are skipped, so this is cheap on a quiet night. Best-effort: a doc-ingest failure
  //    must never sink the rest of the dream pass.
  try {
    const docs = ingestContentDocs(db, llm);
    result.docsIngested = docs.ingested + docs.updated;
  } catch {
    result.docsIngested = 0;
  }

  // 11. Apply topic-linked corrections → auto-retract contradicted belief heads.
  //     Only corrections with an explicit `topic` link are replayed; behavioral/global
  //     corrections (NULL topic) are left untouched. Best-effort: a failure here must
  //     never sink the rest of the dream pass.
  try {
    const corrections = applyCorrections(db, llm, now);
    result.correctionsApplied = corrections.processed;
    result.beliefsRetracted = corrections.retracted;
  } catch {
    result.correctionsApplied = 0;
    result.beliefsRetracted = 0;
  }

  // 12. Compose and persist a learning digest — closes feedback loops by
  //     summarizing handler outcomes, calibration, belief lifecycle, corrections,
  //     and agent-run failure signals into a single event. Best-effort.
  try {
    composeLearningDigest(db, result, now);
    result.digestGenerated = true;
  } catch {
    result.digestGenerated = false;
  }

  return result;
}

/**
 * Epoch-ms of a timestamp string. The truth substrate stores two formats:
 * belief.update events use ISO (`…T…Z`, via ingest), corrections use SQLite's
 * space form (`YYYY-MM-DD HH:MM:SS`, UTC). `Date.parse` reads the ISO form
 * natively; the space form is normalized to ISO+Z first so it parses as UTC.
 * Returns NaN for an unparseable value.
 */
function tsToMillis(ts: string): number {
  const direct = Date.parse(ts);
  if (!Number.isNaN(direct)) return direct;
  return Date.parse(`${ts.replace(' ', 'T')}Z`);
}

/**
 * For each `*.md` prose doc under `<userDataDir>/content/profile/`, raise a
 * `narrative.stale` event when the newest belief or correction timestamp is
 * newer than the doc's file mtime — a signal that the curated prose may lag
 * the structured truth. Flag only; no generation. Dedups against an unresolved
 * `narrative.stale` event for the same doc raised earlier today. Missing
 * content/profile dir → 0 flags.
 */
function flagStaleNarrativeDocs(db: RobinDb, now: Date): number {
  const profileDir = join(resolveUserDataDir(), 'content', 'profile');
  let docs: string[];
  try {
    docs = readdirSync(profileDir).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }
  if (docs.length === 0) return 0;

  // Newest belief and correction timestamps across the whole substrate.
  const newestBelief = (
    db.prepare(`SELECT MAX(ts) AS ts FROM events WHERE kind = 'belief.update'`).get() as {
      ts: string | null;
    }
  ).ts;
  const newestCorrection = (
    db.prepare(`SELECT MAX(ts) AS ts FROM corrections`).get() as { ts: string | null }
  ).ts;
  const signalMillis = [newestBelief, newestCorrection]
    .filter((t): t is string => !!t)
    .map(tsToMillis)
    .filter((m) => !Number.isNaN(m));
  if (signalMillis.length === 0) return 0;
  const newestSignalMillis = Math.max(...signalMillis);

  const today = now.toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00.000Z`;
  const existsToday = db.prepare(`
    SELECT 1 FROM events
     WHERE kind = 'narrative.stale' AND ts >= ? AND status != 'resolved'
       AND json_extract(payload, '$.doc') = ?
     LIMIT 1
  `);
  const insertFlag = db.prepare(`
    INSERT INTO events (ts, kind, source, status, payload)
    VALUES (?, 'narrative.stale', 'dream', 'ok', ?)
  `);

  let raised = 0;
  for (const doc of docs) {
    const mtimeMs = statSync(join(profileDir, doc)).mtimeMs;
    if (newestSignalMillis <= mtimeMs) continue;

    if (existsToday.get(dayStart, doc)) continue;

    insertFlag.run(
      now.toISOString(),
      JSON.stringify({
        doc,
        reason: 'beliefs/corrections updated after doc',
        newest_signal_ts: new Date(newestSignalMillis).toISOString(),
        doc_mtime: new Date(mtimeMs).toISOString(),
      }),
    );
    raised++;
  }
  return raised;
}

/**
 * Regenerate `profile` on entities that picked up >= ENTITY_SUMMARY_MIN_SIGNALS new relations
 * today. Bounded by ENTITY_SUMMARY_MAX_PER_RUN per night so cost stays predictable. Skips silently
 * when LLM unavailable so the rest of dream still runs.
 */
export async function summarizeHotEntities(
  db: RobinDb,
  llm: LLMDispatcher | null,
  since: string,
): Promise<number> {
  if (!llm) return 0;

  // Hot entities: count relations involving each entity today
  const hot = db
    .prepare(`
      SELECT e.id, e.type, e.canonical_name, COUNT(*) AS signals
        FROM entities e
        JOIN relations r ON r.subject_id = e.id OR r.object_id = e.id
       WHERE r.ts >= ?
       GROUP BY e.id
      HAVING signals >= ?
       ORDER BY signals DESC
       LIMIT ?
    `)
    .all(since, ENTITY_SUMMARY_MIN_SIGNALS, ENTITY_SUMMARY_MAX_PER_RUN) as Array<{
    id: number;
    type: string;
    canonical_name: string;
    signals: number;
  }>;

  let updated = 0;
  for (const ent of hot) {
    // Pull up to 20 recent relations touching this entity, along with the other side's name.
    // The signal here is "what predicates + counterparties has Robin seen for this entity recently."
    const observations = db
      .prepare(`
        SELECT r.predicate, r.ts,
               CASE WHEN r.subject_id = ? THEN obj.canonical_name ELSE sub.canonical_name END AS other,
               CASE WHEN r.subject_id = ? THEN 'subject' ELSE 'object' END AS role
          FROM relations r
          JOIN entities sub ON sub.id = r.subject_id
          JOIN entities obj ON obj.id = r.object_id
         WHERE r.subject_id = ? OR r.object_id = ?
         ORDER BY r.ts DESC
         LIMIT 20
      `)
      .all(ent.id, ent.id, ent.id, ent.id) as Array<{
      predicate: string;
      ts: string;
      other: string;
      role: string;
    }>;
    if (observations.length === 0) continue;

    const observationLines = observations
      .map((o) =>
        o.role === 'subject'
          ? `${ent.canonical_name} ${o.predicate} ${o.other}`
          : `${o.other} ${o.predicate} ${ent.canonical_name}`,
      )
      .join('\n');

    try {
      const res = await llm.invoke('summarize', {
        systemPrompt: `You synthesize a 1-3 sentence profile of an entity from observed relations. Be concise, factual, no preamble. Avoid speculation; only state what the observations support.`,
        messages: [
          {
            role: 'user',
            content: `Entity: ${ent.canonical_name} (${ent.type})\n\nRecent observations:\n${observationLines}\n\nWrite the profile.`,
          },
        ],
        temperature: 0,
      });
      const profile = res.text.trim().slice(0, 1000);
      if (profile) {
        db.prepare(
          `UPDATE entities SET profile = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(profile, ent.id);
        updated++;
      }
    } catch {
      // Don't block other entities on a single failure
    }
  }
  return updated;
}

/**
 * Cluster `session.captured` events from the last 14 days by shared entities and persist each
 * cluster as a `kind='arc'` event. Dedups against existing arcs from the same window by Jaccard
 * similarity over member event ids — re-running dream the same day extends rather than duplicates.
 */
export function detectArcs(db: RobinDb, now: Date): number {
  const cutoffTs = new Date(now.getTime() - ARC_RECENCY_DAYS * 86_400_000).toISOString();

  // Map of event_id -> set of entity_ids that appear in its relations
  const eventEntities = new Map<number, Set<number>>();
  const eventTs = new Map<number, string>();
  const rows = db
    .prepare(`
      SELECT e.id AS eventId, e.ts AS ts, r.subject_id AS sid, r.object_id AS oid
        FROM events e
        JOIN relations r ON r.source_event_id = e.id
       WHERE e.kind = 'session.captured' AND e.ts >= ?
    `)
    .all(cutoffTs) as Array<{ eventId: number; ts: string; sid: number; oid: number }>;
  for (const r of rows) {
    let ents = eventEntities.get(r.eventId);
    if (!ents) {
      ents = new Set();
      eventEntities.set(r.eventId, ents);
    }
    ents.add(r.sid);
    ents.add(r.oid);
    eventTs.set(r.eventId, r.ts);
  }

  // Greedy clustering: walk events in chronological order, merge into any cluster that
  // shares >= ARC_MIN_SHARED_ENTITIES with the cluster's accumulated entity set.
  const entries = [...eventEntities.entries()].sort((a, b) =>
    (eventTs.get(a[0]) ?? '').localeCompare(eventTs.get(b[0]) ?? ''),
  );
  const clusters: Array<{ events: number[]; entities: Set<number> }> = [];
  for (const [eventId, ents] of entries) {
    let placed = false;
    for (const c of clusters) {
      let shared = 0;
      for (const e of ents) if (c.entities.has(e)) shared++;
      if (shared >= ARC_MIN_SHARED_ENTITIES) {
        c.events.push(eventId);
        for (const e of ents) c.entities.add(e);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ events: [eventId], entities: new Set(ents) });
  }
  const significant = clusters.filter((c) => c.events.length >= ARC_MIN_EVENTS);
  if (significant.length === 0) return 0;

  // Existing arcs from the same window — for Jaccard-based dedup
  const existing = db
    .prepare(`
      SELECT id, payload FROM events WHERE kind = 'arc' AND ts >= ?
    `)
    .all(cutoffTs) as Array<{ id: number; payload: string }>;
  const existingArcs = existing.map((r) => {
    try {
      const p = JSON.parse(r.payload) as { member_event_ids?: number[] };
      return { id: r.id, members: new Set(p.member_event_ids ?? []) };
    } catch {
      return { id: r.id, members: new Set<number>() };
    }
  });

  let created = 0;
  const insertArc = db.prepare(`
    INSERT INTO events (ts, kind, source, status, payload)
    VALUES (?, 'arc', 'dream', 'ok', ?)
  `);
  for (const c of significant) {
    const memberIds = c.events.slice().sort((a, b) => a - b);
    // Skip if a Jaccard-similar arc already exists
    const sigSet = new Set(memberIds);
    const dup = existingArcs.some((a) => jaccard(a.members, sigSet) >= ARC_JACCARD_MERGE_THRESHOLD);
    if (dup) continue;

    const startTs = memberIds
      .map((id) => eventTs.get(id) ?? '')
      .reduce((min, t) => (min === '' || t < min ? t : min), '');
    const endTs = memberIds
      .map((id) => eventTs.get(id) ?? '')
      .reduce((max, t) => (t > max ? t : max), '');
    const entityIds = [...c.entities].sort((a, b) => a - b);
    const summary = `Activity arc across ${memberIds.length} sessions involving ${entityIds.length} entities`;
    insertArc.run(
      now.toISOString(),
      JSON.stringify({
        start_ts: startTs,
        end_ts: endTs,
        member_event_ids: memberIds,
        entity_ids: entityIds,
        summary,
      }),
    );
    created++;
  }
  return created;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Belief lifecycle pass ─────────────────────────────────────────────────────

const PROMOTE_AGE_DAYS = 7;

interface PromoteResult {
  promoted: number;
  conflicted: number;
  merged: number;
  gateBlocked: number;
}

interface CandidateRow {
  id: number;
  topic: string;
  claim: string;
  confidence: number | null;
}

// Negation tokens. A claim that has one of these while the other doesn't is a
// potential factual flip ("owns X" vs "no longer owns X") — never treat such a
// pair as a mere rephrasing.
const NEGATION_RE = /\b(?:not|no|never|n't|without|nor|none|cannot|can't|didn't|doesn't|isn't|wasn't)\b|no longer/i;

const CLAIM_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'of', 'to', 'in',
  'on', 'at', 'as', 'and', 'or', 'his', 'her', 'their', 'its', 'with', 'for',
  'that', 'this', 'has', 'have', 'had', 'by', 'from', 'also', 'per', 'about',
]);

function claimTokens(claim: string): Set<string> {
  return new Set(
    claim
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !CLAIM_STOPWORDS.has(t)),
  );
}

/**
 * Decide whether `cand` merely rephrases/elaborates `head` (same underlying fact)
 * versus genuinely diverges from it. Deterministic and SAFE-by-design via content-
 * token SUBSUMPTION: a rephrasing is one where one claim's content tokens fully
 * contain the other's (an elaboration adds detail; a restatement drops it). When
 * each side carries a unique key token, that token usually IS the differing fact
 * ("likes red" vs "likes blue" — neither subsumes the other → NOT a rephrasing →
 * stays conflicted). A negation-polarity mismatch is an automatic non-rephrasing
 * so a factual flip is never absorbed.
 *
 * This under-merges (a synonym swap like "girlfriend"↔"partner" stays conflicted)
 * rather than over-merges — the safe direction. Burying a real contradiction is a
 * far worse failure than leaving a benign rephrasing flagged for review.
 */
function isRephrasingOfHead(head: string, cand: string): boolean {
  if (NEGATION_RE.test(head) !== NEGATION_RE.test(cand)) return false;
  const a = claimTokens(head);
  const b = claimTokens(cand);
  if (a.size === 0 || b.size === 0) return false;
  const aSubsetOfB = [...a].every((t) => b.has(t));
  const bSubsetOfA = [...b].every((t) => a.has(t));
  return aSubsetOfB || bSubsetOfA;
}

/**
 * Auto-promote pending belief candidates older than 7 days. Detects
 * contradictions against existing belief heads, folds same-fact rephrasings into
 * the head (merged), and merges near-duplicates. Fully deterministic — no LLM.
 * Returns counters for each outcome.
 */
export function promoteStableCandidates(db: RobinDb, now: Date = new Date()): PromoteResult {
  const cutoff = new Date(now.getTime() - PROMOTE_AGE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const candidates = db
    .prepare(
      `SELECT id, topic, claim, confidence FROM belief_candidates
       WHERE status = 'pending' AND created_at < ?
       ORDER BY id`,
    )
    .all(cutoff) as CandidateRow[];

  if (candidates.length === 0) return { promoted: 0, conflicted: 0, merged: 0, gateBlocked: 0 };

  const counts: PromoteResult = { promoted: 0, conflicted: 0, merged: 0, gateBlocked: 0 };

  // Track ids already resolved in this run (merged/conflicted) to skip them.
  const resolved = new Set<number>();

  // Pre-pass: near-duplicate merge among the pending set. Compares CLAIM text,
  // not topic slugs — the same fact often lands under divergent slugs
  // ("aerospace-corp-claim", "no-aerospace-internship", "aerospace-internship-false"),
  // which a topic-keyed merge misses entirely (observed 2026-05-28: 7 belief heads
  // for one fact). Claim-text similarity catches them regardless of slug.
  for (let i = 0; i < candidates.length; i++) {
    if (resolved.has(candidates[i].id)) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      if (resolved.has(candidates[j].id)) continue;
      const a = candidates[i];
      const b = candidates[j];

      const longer = Math.max(a.claim.length, b.claim.length);
      if (longer === 0) continue;
      // Cheap short-circuit: levenshtein(a,b) >= |len(a)-len(b)|, so if the
      // length gap alone already exceeds the 0.2 threshold they can never merge.
      // Skips the O(L²) distance computation for the vast majority of pairs now
      // that the merge spans all topics, not just same-topic groups.
      if (Math.abs(a.claim.length - b.claim.length) / longer >= 0.2) continue;
      const dist = levenshtein(a.claim, b.claim);
      if (dist / longer < 0.2) {
        // Merge: keep the higher-confidence one, resolve the other.
        const confA = a.confidence ?? 0;
        const confB = b.confidence ?? 0;
        const loserId = confA >= confB ? b.id : a.id;
        db.prepare(
          `UPDATE belief_candidates SET status = 'merged', resolved_at = datetime('now') WHERE id = ?`,
        ).run(loserId);
        resolved.add(loserId);
        counts.merged++;
        // If the loser was `a`, swap winner into slot i so subsequent j comparisons use the winner.
        if (loserId === a.id) {
          candidates[i] = candidates[j];
          resolved.add(a.id);
          break; // restart j loop with the new i candidate handled by outer loop
        }
      }
    }
  }

  // Main pass: contradiction check + promote.
  for (const cand of candidates) {
    if (resolved.has(cand.id)) continue;

    // Contradiction check: look for a belief head on the same topic with different claim text.
    const head = db
      .prepare(
        `SELECT json_extract(payload, '$.topic') AS topic,
                c.body AS claim
           FROM events e
           LEFT JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = 'belief.update'
            AND json_extract(e.payload, '$.topic') = ?
            AND (json_extract(e.payload, '$.retracted') IS NULL
              OR json_extract(e.payload, '$.retracted') = 0
              OR json_extract(e.payload, '$.retracted') = false)
          ORDER BY e.ts DESC, e.id DESC
          LIMIT 1`,
      )
      .get(cand.topic) as { topic: string; claim: string | null } | undefined;

    if (head?.claim && head.claim.trim() !== cand.claim.trim()) {
      // Same fact, different words → fold into the head (merged), not a conflict.
      // Only genuine divergence (low token overlap or a negation flip) stays
      // `conflicted` for review. This stops the detector flagging every reworded
      // restatement of a fact the head already holds.
      const rephrasing = isRephrasingOfHead(head.claim, cand.claim);
      db.prepare(
        `UPDATE belief_candidates SET status = ?, resolved_at = datetime('now') WHERE id = ?`,
      ).run(rephrasing ? 'merged' : 'conflicted', cand.id);
      resolved.add(cand.id);
      if (rephrasing) counts.merged++;
      else counts.conflicted++;
      continue;
    }

    // Promote via resolveBeliefCandidate (which enforces P3 formation gate).
    try {
      const res = resolveBeliefCandidate(db, null, cand.id, 'promote');
      if (res.blockedReason) {
        counts.gateBlocked++;
      } else {
        counts.promoted++;
      }
    } catch {
      // Candidate may already be resolved (race) or other error — skip.
    }
    resolved.add(cand.id);
  }

  return counts;
}

// ── Depth synthesis queries ───────────────────────────────────────────────────

export interface DecisionReplay {
  topic: string;
  revisions: number;
}

export interface PredictionCalibrationRow {
  outcome: string;
  count: number;
  avgBrier: number | null;
}

export interface ApproachingDeadline {
  type: 'prediction' | 'linear';
  label: string;
  deadline: string;
}

/**
 * Topics where beliefs were revised more than once in the last `days` days —
 * signals Kevin is revisiting the same decision.
 */
export function queryDecisionReplays(db: RobinDb, days = 30): DecisionReplay[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT json_extract(payload, '$.topic') AS topic, COUNT(*) AS revisions
         FROM events
        WHERE kind = 'belief.update' AND ts > ?
        GROUP BY json_extract(payload, '$.topic')
       HAVING COUNT(*) > 1
        ORDER BY revisions DESC
        LIMIT 10`,
    )
    .all(cutoff) as DecisionReplay[];
}

/**
 * Prediction accuracy grouped by outcome (right/wrong/unverifiable), with
 * average Brier delta per bucket.
 */
export function queryPredictionCalibration(db: RobinDb): PredictionCalibrationRow[] {
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS count, AVG(brier_delta) AS avgBrier
         FROM predictions
        WHERE outcome IS NOT NULL
        GROUP BY outcome`,
    )
    .all() as Array<{ outcome: string; count: number; avgBrier: number | null }>;
  return rows.map((r) => ({ outcome: r.outcome, count: r.count, avgBrier: r.avgBrier }));
}

/**
 * Predictions and Linear issues with deadlines in the next `daysAhead` days.
 */
export function queryApproachingDeadlines(
  db: RobinDb,
  now: Date = new Date(),
  daysAhead = 7,
): ApproachingDeadline[] {
  const nowIso = now.toISOString();
  const endIso = new Date(now.getTime() + daysAhead * 86_400_000).toISOString();
  const results: ApproachingDeadline[] = [];

  // Predictions with approaching deadlines.
  const preds = db
    .prepare(
      `SELECT claim, deadline FROM predictions
        WHERE outcome IS NULL AND deadline >= ? AND deadline <= ?
        ORDER BY deadline`,
    )
    .all(nowIso, endIso) as Array<{ claim: string; deadline: string }>;
  for (const p of preds) {
    results.push({ type: 'prediction', label: p.claim, deadline: p.deadline });
  }

  // Linear issues with due dates in the window (from captured integration events).
  try {
    const linearRows = db
      .prepare(
        `SELECT payload FROM events
          WHERE kind = 'integration.linear.issue' AND status = 'ok'
          ORDER BY ts DESC LIMIT 200`,
      )
      .all() as Array<{ payload: string }>;
    for (const row of linearRows) {
      try {
        const p = JSON.parse(row.payload) as {
          identifier?: string;
          title?: string;
          dueDate?: string;
        };
        if (p.dueDate && p.dueDate >= nowIso.slice(0, 10) && p.dueDate <= endIso.slice(0, 10)) {
          results.push({
            type: 'linear',
            label: p.identifier ? `${p.identifier}: ${p.title ?? ''}` : (p.title ?? 'untitled'),
            deadline: p.dueDate,
          });
        }
      } catch {
        // Skip unparseable rows.
      }
    }
  } catch {
    // Table or column may not exist on older DBs — skip.
  }

  return results;
}

// ── Journal ───────────────────────────────────────────────────────────────────

interface JournalContext {
  today: string;
  eventsToday: number;
  capturesToday: number;
  correctionsToday: number;
  predictionsResolved: number;
  entitiesSummarized: number;
  arcsCreated: number;
  decisionReplays?: DecisionReplay[];
  predictionCalibration?: PredictionCalibrationRow[];
  approachingDeadlines?: ApproachingDeadline[];
}

/**
 * Deterministic metrics-only journal with optional depth synthesis sections.
 * This is the substrate fallback: the nightly dream-synthesis pass (4:00am,
 * user-data job) upserts a richer narrative over the same `journals` day key
 * (ON CONFLICT DO UPDATE) once it has reasoned on the consolidated substrate.
 * dream.run owns no LLM narrative — it only guarantees a journal row exists
 * for the day.
 */
function composeJournal(ctx: JournalContext): string {
  const lines = [
    `# Robin Journal — ${ctx.today}`,
    ``,
    `**Captured:** ${ctx.capturesToday} sessions`,
    `**Corrections:** ${ctx.correctionsToday}`,
    `**Events:** ${ctx.eventsToday}`,
    `**Predictions resolved (overdue → unverifiable):** ${ctx.predictionsResolved}`,
    `**Entities summarized:** ${ctx.entitiesSummarized}`,
    `**Arcs created:** ${ctx.arcsCreated}`,
  ];

  // Depth synthesis sections — appended only when data exists.
  if (ctx.decisionReplays && ctx.decisionReplays.length > 0) {
    lines.push(
      ``,
      `**Decision replays (30d):** ${ctx.decisionReplays.map((r) => `${r.topic} revised ${r.revisions}×`).join(', ')}`,
    );
  }

  if (ctx.predictionCalibration && ctx.predictionCalibration.length > 0) {
    const parts: string[] = [];
    for (const row of ctx.predictionCalibration) {
      const brier = row.avgBrier != null ? `; avg Brier: ${row.avgBrier.toFixed(2)}` : '';
      parts.push(`${row.count} ${row.outcome}${brier}`);
    }
    lines.push(``, `**Prediction calibration:** ${parts.join(', ')}`);
  }

  if (ctx.approachingDeadlines && ctx.approachingDeadlines.length > 0) {
    const parts = ctx.approachingDeadlines.map(
      (d) =>
        `${d.type === 'prediction' ? 'prediction' : d.label.split(':')[0]} due ${d.deadline.slice(0, 10)}`,
    );
    lines.push(``, `**Approaching deadlines:** ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

// ── Learning digest ─────────────────────────────────────────────────────────

/**
 * Compute a structured learning digest from deterministic SQL queries (no LLM)
 * and persist it as a `dream.learning_digest` event. Deduplicates by day via
 * `payload.external_id = 'learning-digest:YYYY-MM-DD'` — the ingest module's
 * upsert path ensures at most one digest per day.
 */
export function composeLearningDigest(db: RobinDb, result: DreamResult, now: Date): LearningDigest {
  const today = now.toISOString().slice(0, 10);
  const cutoff24h = new Date(now.getTime() - 24 * 3600_000).toISOString();

  // a. Handler activity summary (last 24h)
  let handlerActivity: HandlerActivityRow[] = [];
  try {
    handlerActivity = db
      .prepare(
        `SELECT surface, count(*) AS runs, COALESCE(sum(cost_usd), 0) AS cost,
                COALESCE(sum(turns), 0) AS turns, group_concat(DISTINCT label) AS handlers
         FROM agent_usage WHERE ts > ? GROUP BY surface`,
      )
      .all(cutoff24h) as HandlerActivityRow[];
  } catch {
    // agent_usage table may not exist on older DBs
  }

  // b. Prediction calibration snapshot
  let predictionsByOutcome: Array<{ outcome: string; n: number }> = [];
  let overallBrier: number | null = null;
  let openPredictions = { count: 0, nearestDeadline: null as string | null };
  try {
    predictionsByOutcome = db
      .prepare(
        `SELECT outcome, count(*) AS n FROM predictions WHERE outcome IS NOT NULL GROUP BY outcome`,
      )
      .all() as Array<{ outcome: string; n: number }>;

    const brierRow = db
      .prepare(
        `SELECT avg(brier_delta) AS avg_brier FROM predictions WHERE brier_delta IS NOT NULL`,
      )
      .get() as { avg_brier: number | null } | undefined;
    overallBrier = brierRow?.avg_brier ?? null;

    const openRow = db
      .prepare(
        `SELECT count(*) AS cnt, min(deadline) AS nearest FROM predictions WHERE outcome IS NULL`,
      )
      .get() as { cnt: number; nearest: string | null } | undefined;
    openPredictions = {
      count: openRow?.cnt ?? 0,
      nearestDeadline: openRow?.nearest ?? null,
    };
  } catch {
    // predictions table may not exist on older DBs
  }

  // c. Belief lifecycle snapshot
  let pendingCandidates = 0;
  let activeBeliefHeads = 0;
  try {
    pendingCandidates = (
      db.prepare(`SELECT count(*) AS n FROM belief_candidates WHERE status = 'pending'`).get() as {
        n: number;
      }
    ).n;
  } catch {
    // belief_candidates may not exist
  }
  try {
    activeBeliefHeads = (
      db
        .prepare(
          `SELECT count(DISTINCT json_extract(payload, '$.topic')) AS n FROM events
           WHERE kind = 'belief.update'
             AND (json_extract(payload, '$.retracted') IS NULL
               OR json_extract(payload, '$.retracted') = 0
               OR json_extract(payload, '$.retracted') = false)`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    // best-effort
  }

  // d. Correction coverage
  let corrections = { total: 0, behavioral: 0, topicLinked: 0, unapplied: 0 };
  try {
    const totalRow = db.prepare(`SELECT count(*) AS n FROM corrections`).get() as { n: number };
    const behavioralRow = db
      .prepare(`SELECT count(*) AS n FROM corrections WHERE topic IS NULL`)
      .get() as { n: number };
    const topicLinkedRow = db
      .prepare(`SELECT count(*) AS n FROM corrections WHERE topic IS NOT NULL`)
      .get() as { n: number };
    const unappliedRow = db
      .prepare(`SELECT count(*) AS n FROM corrections WHERE topic IS NOT NULL AND applied = 0`)
      .get() as { n: number };
    corrections = {
      total: totalRow.n,
      behavioral: behavioralRow.n,
      topicLinked: topicLinkedRow.n,
      unapplied: unappliedRow.n,
    };
  } catch {
    // corrections table or topic column may not exist
  }

  // e. Recent agent-run failures (last 24h)
  let failedRuns: Array<{ surface: string; label: string | null; status: string; ts: string }> = [];
  try {
    failedRuns = db
      .prepare(
        `SELECT surface, label, status, ts FROM agent_usage
         WHERE ts > ? AND status IS NOT NULL AND status != 'success'
         ORDER BY ts DESC LIMIT 20`,
      )
      .all(cutoff24h) as typeof failedRuns;
  } catch {
    // agent_usage may not exist
  }

  const digest: LearningDigest = {
    handlerActivity,
    predictionsByOutcome,
    overallBrier,
    openPredictions,
    beliefLifecycle: {
      promoted: result.candidatesPromoted,
      conflicted: result.candidatesConflicted,
      merged: result.candidatesMerged,
      expired: result.candidatesExpired,
      pendingCandidates,
      activeBeliefHeads,
    },
    corrections,
    failedRuns,
  };

  // Persist as an event with external_id-based dedup (one per day).
  const externalId = `learning-digest:${today}`;
  const existing = db
    .prepare(
      `SELECT id FROM events
       WHERE source = 'dream' AND json_extract(payload, '$.external_id') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(externalId) as { id: number } | undefined;

  const payload = JSON.stringify({ external_id: externalId, digest });
  if (existing) {
    db.prepare(`UPDATE events SET ts = ?, payload = ? WHERE id = ?`).run(
      now.toISOString(),
      payload,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO events (ts, kind, source, status, payload)
       VALUES (?, 'dream.learning_digest', 'dream', 'ok', ?)`,
    ).run(now.toISOString(), payload);
  }

  return digest;
}

/**
 * Render a learning digest as a compact text summary suitable for the primer
 * or handler goal injection.
 */
export function renderLearningDigest(digest: LearningDigest): string {
  const lines: string[] = [];

  // Predictions
  const outcomeStrs = digest.predictionsByOutcome.map((o) => `${o.n} ${o.outcome}`);
  const brierStr =
    digest.overallBrier != null ? `Brier: ${digest.overallBrier.toFixed(2)} (lower=better)` : '';
  const predParts = [...outcomeStrs, brierStr].filter(Boolean);
  if (predParts.length > 0) lines.push(`- Predictions: ${predParts.join(', ')}`);
  if (digest.openPredictions.count > 0) {
    const deadlineStr = digest.openPredictions.nearestDeadline
      ? `, nearest deadline: ${digest.openPredictions.nearestDeadline.slice(0, 10)}`
      : '';
    lines.push(`- ${digest.openPredictions.count} open predictions${deadlineStr}`);
  }

  // Beliefs
  const bl = digest.beliefLifecycle;
  lines.push(
    `- Beliefs: ${bl.promoted} promoted, ${bl.conflicted} conflicted, ${bl.merged} merged; ${bl.pendingCandidates} candidates pending`,
  );

  // Agent runs
  if (digest.handlerActivity.length > 0) {
    const parts = digest.handlerActivity.map(
      (h) => `${h.runs} ${h.surface} ($${h.cost.toFixed(2)})`,
    );
    const failures = digest.failedRuns.length;
    const failStr = failures > 0 ? `; ${failures} failed` : '';
    lines.push(`- Agent runs: ${parts.join(', ')}${failStr}`);
  }

  // Corrections
  const c = digest.corrections;
  if (c.total > 0) {
    const topicStr =
      c.topicLinked > 0 ? `, ${c.topicLinked} topic-linked (${c.unapplied} unapplied)` : '';
    lines.push(`- Corrections: ${c.total} total (${c.behavioral} behavioral${topicStr})`);
  }

  return lines.join('\n');
}

/**
 * Read the latest learning digest from the events table and return a compact
 * text summary. Returns null if no digest has been computed yet.
 */
export function latestLearningDigest(db: RobinDb): string | null {
  let row: { payload: string } | undefined;
  try {
    row = db
      .prepare(
        `SELECT payload FROM events WHERE kind = 'dream.learning_digest' ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.payload) as { digest?: LearningDigest };
    if (!parsed.digest) return null;
    return renderLearningDigest(parsed.digest);
  } catch {
    return null;
  }
}

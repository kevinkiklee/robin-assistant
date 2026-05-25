import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { applyCorrections } from '../learning/apply-corrections.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { expireStaleCandidates } from '../memory/belief-candidate.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBeliefFreshness } from './belief-freshness.ts';
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
 * 1. Resolves overdue predictions as 'unverifiable'
 * 2. Rolls up daily metric counts
 * 3. Summarizes hot entities (signal_count >= threshold among today's relations)
 * 4. Detects narrative arcs from session.captured events in the last 14 days
 * 5. Writes a deterministic metrics-only journal (the 4:00am dream-synthesis
 *    pass upserts a richer narrative over the same day key later)
 * 6. Expires stale belief candidates (pending > 14 days)
 * 7. Scans live belief heads for staleness; re-queries via registered resolvers
 *    (bounded) or flags with belief.stale events (idempotent)
 * 8. Flags prose docs in content/profile that are older than the newest belief/correction signal
 * 9. Indexes content/* markdown docs for recall (idempotent)
 * 10. Replays topic-linked corrections: retracts contradicted belief heads (P4 close-the-loop)
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
  };

  // 1. Auto-resolve predictions past deadline as 'unverifiable' if not already resolved
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

  // 2. Metrics rollup for today
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

  // 3. Entity summarization — regenerate profiles for hot entities
  result.entitiesSummarized = await summarizeHotEntities(db, llm, since);

  // 4. Arc detection — cluster recent captured events by shared entities
  result.arcsCreated = detectArcs(db, now);

  // 5. Compose journal — deterministic metrics-only block. The 4:00am
  //    dream-synthesis pass upserts a richer narrative over this same day key
  //    later; dream.run only guarantees the row exists as a fallback.
  const journal = composeJournal({
    today,
    eventsToday,
    capturesToday,
    correctionsToday,
    predictionsResolved: result.predictionsResolved,
    entitiesSummarized: result.entitiesSummarized,
    arcsCreated: result.arcsCreated,
  });
  db.prepare(`
    INSERT INTO journals (day, body) VALUES (?, ?)
    ON CONFLICT (day) DO UPDATE SET body=excluded.body, generated_at=datetime('now')
  `).run(today, journal);
  result.journalGenerated = true;

  // 6. Expire stale belief candidates. Guarded so an older DB without the
  //    belief_candidates table can't crash the whole dream pass.
  try {
    result.candidatesExpired = expireStaleCandidates(db, CANDIDATE_EXPIRY_DAYS, now);
  } catch {
    result.candidatesExpired = 0;
  }

  // 7. Belief freshness — scan live belief heads, re-query via registered resolvers
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

  // 8. Narrative staleness flags — prose docs older than the newest belief/correction signal.
  result.staleFlagsRaised = flagStaleNarrativeDocs(db, now);

  // 9. Keep content/* markdown docs indexed for recall. Idempotent — unchanged files
  //    are skipped, so this is cheap on a quiet night. Best-effort: a doc-ingest failure
  //    must never sink the rest of the dream pass.
  try {
    const docs = ingestContentDocs(db, llm);
    result.docsIngested = docs.ingested + docs.updated;
  } catch {
    result.docsIngested = 0;
  }

  // 10. Apply topic-linked corrections → auto-retract contradicted belief heads.
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

interface JournalContext {
  today: string;
  eventsToday: number;
  capturesToday: number;
  correctionsToday: number;
  predictionsResolved: number;
  entitiesSummarized: number;
  arcsCreated: number;
}

/**
 * Deterministic metrics-only journal. This is the substrate fallback: the
 * nightly dream-synthesis pass (4:00am, user-data job) upserts a richer
 * narrative over the same `journals` day key (ON CONFLICT DO UPDATE) once it
 * has reasoned on the consolidated substrate. dream.run owns no LLM narrative —
 * it only guarantees a journal row exists for the day.
 */
function composeJournal(ctx: JournalContext): string {
  return [
    `# Robin Journal — ${ctx.today}`,
    ``,
    `**Captured:** ${ctx.capturesToday} sessions`,
    `**Corrections:** ${ctx.correctionsToday}`,
    `**Events:** ${ctx.eventsToday}`,
    `**Predictions resolved (overdue → unverifiable):** ${ctx.predictionsResolved}`,
    `**Entities summarized:** ${ctx.entitiesSummarized}`,
    `**Arcs created:** ${ctx.arcsCreated}`,
  ].join('\n');
}

import { z } from 'zod';
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';
import { TimeoutError, withTimeout } from '../../lib/with-timeout.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { insertCandidateWithDedup } from '../memory/belief-candidate.ts';
import type { RobinDb } from '../memory/db.ts';
import { addRelation, findEntity, upsertEntity } from '../memory/entity.ts';
import { isPersonalDomain } from '../memory/domains.ts';
import { classifyProvenance } from '../memory/provenance.ts';
import { loadNoiseBlocklist } from './hygiene.ts';

/**
 * True when an error means the LLM was unreachable / didn't respond (Ollama down,
 * connection refused/reset, or a timeout) — as opposed to the LLM responding with
 * bad output (JSON parse / schema failure). The distinction is load-bearing in the
 * biographer chunk loop: an unreachable LLM must NOT advance the cursor (else a
 * session gets marked "done" with empty extraction — observed 2026-05-23 when a
 * reboot left Ollama down and ~30 sessions were silently emptied), whereas a
 * bad-output chunk SHOULD advance so one poison chunk can't block the session.
 */
function isLlmUnavailableError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // `spend cap exceeded` = the dispatcher's SpendCapError; treat a tripped daily
  // cloud-spend cap like an outage (abort the tick, don't advance the cursor or
  // write empty extraction) so a runaway loop stops without losing data.
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|network|failed to connect|connection refused|terminated|fetch is not defined|spend cap exceeded|subscription limit/i.test(
    msg,
  );
}

/**
 * Definitive, content-independent outages: the subscription account is
 * usage-limited (claude-agent's SubscriptionLimitError — the SDK returns the
 * limit banner as "successful" text) or the dispatcher's daily spend cap
 * tripped. Unlike timeouts — which may be one poison chunk and must advance
 * past it — these mean NO chunk can succeed until the limit window resets, so
 * the only correct move is to stop work without advancing any cursor and
 * without burning bounded retry attempts. Observed live 2026-06-12: a 3-day
 * Sonnet limit emptied ~1,000 session extractions because the banner read as
 * bad model output instead of an outage.
 */
function isHardLlmOutage(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /subscription limit|spend cap exceeded/i.test(msg);
}

// Bug E mitigation — bound any single chunk's LLM call so one stuck chunk can't
// block the scheduler forever. With maxTokens=4096 on the invoke, generation is
// bounded to ~77s at 53 tok/s regardless of thinking length — so 2 min is
// generous (catches genuine hangs without flagging real work). With
// MAX_CHUNKS_PER_TICK=30 (cranked for backlog drain) the theoretical worst-case
// tick is 30 × 2 = 60 min, which exceeds both the scheduler's HANDLER_TIMEOUT_MS
// (20 min) and the heartbeat hard-exit (~37 min) — but only if nearly every
// chunk hangs to its timeout (model down). Normal chunks finish in ~16s, so a
// real 30-chunk tick is ~8 min. If a tick is clipped by the scheduler cap, the
// per-chunk progress persistence lets the next cron resume from where it left.
const BIOGRAPHER_CHUNK_TIMEOUT_MS = 2 * 60_000;

// Bug F mitigation — disambiguation is a smaller prompt (a few candidate lines +
// 2KB of source text) so it should finish well under a minute. The ceiling here
// matters because each extracted entity triggers an LLM call, and a session can
// have 5-50 entities — one hung disambiguation hangs the whole biographer.run.
// 1 min is generous for the prompt size; falls back to the catch path in
// disambiguateEntity which picks the oldest candidate.
const DISAMBIGUATION_TIMEOUT_MS = 60_000;

const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
      }),
    )
    .default([]),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

// ─── Second-pass claim drafting ────────────────────────────────────────────────
// A SEPARATE extraction pass, fully decoupled from the entity/relation flow
// above, so it can never threaten that pass's hard-won maxTokens=4096 / 2-min
// stability ceilings. It drafts durable declarative facts about the user into
// the belief_candidates review queue (never the truth stream directly), gated by
// the `draftClaims` config flag and bounded by its own small per-session budget.

export const claimsSchema = z.object({
  claims: z
    .array(
      z.object({
        topic: z.string(),
        claim: z.string(),
        confidence: z.number().nullable().optional(),
        domain: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export type ClaimsResult = z.infer<typeof claimsSchema>;

/**
 * Outcome of a single claim-extraction pass (spec §C3, decision 5).
 *
 * `failure` is set ONLY when the model responded but its output couldn't be
 * trusted — a JSON parse throw or a schema-validation failure. A model that
 * legitimately found nothing durable returns `{ claims: [], failure: undefined }`,
 * which the caller treats as a clean (non-dead-letter) result. The chunk loop
 * relies on this distinction to decide whether to write a dead letter.
 */
export interface ExtractClaimsOutcome {
  claims: ClaimsResult['claims'];
  failure?: string;
}

// ─── Session finalization schema ──────────────────────────────────────────────
// A single LLM call per session, after all chunks are extracted and the merged
// entity/relation set is assembled. Produces intent, outcome, topics, decisions,
// temporal references, and follow-up — the session-level metadata that transforms
// a captured record into actionable knowledge.

export const sessionSummarySchema = z.object({
  intent: z.string(),
  outcome: z.enum(['completed', 'partial', 'abandoned', 'exploratory']),
  outcomeSummary: z.string(),
  topics: z.array(z.string()).max(7),
  decisions: z
    .array(
      z.object({
        choice: z.string(),
        reasoning: z.string(),
      }),
    )
    .default([]),
  temporalRefs: z
    .array(
      z.object({
        reference: z.string(),
        resolvedDate: z.string().nullable(),
      }),
    )
    .default([]),
  followUp: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

const SESSION_SUMMARY_PROMPT = `You summarize a completed conversation session. You receive the opening (and closing, if multi-part), plus entities/relations extracted from the full session. Reply ONLY with JSON matching the schema.

Schema: {"intent":"...","outcome":"completed|partial|abandoned|exploratory","outcomeSummary":"...","topics":["kebab-tags"],"decisions":[{"choice":"...","reasoning":"..."}],"temporalRefs":[{"reference":"...","resolvedDate":"YYYY-MM-DD"|null}],"followUp":"..."|null}

Rules:
- intent: one sentence — why the user started this session
- outcome: classify the PRIMARY stated goal (completed/partial/abandoned/exploratory)
- outcomeSummary: one sentence — what was accomplished or why it stopped
- topics: 2-7 kebab-case tags at the project/domain level (e.g. "leadforge-auth", "whoop-recovery", "nikon-zf-settings") — not code symbols. Reuse existing topic tags when the subject matches a prior session.
- decisions: only EXPLICIT choices with stated reasoning. Empty array if none.
- temporalRefs: dates/deadlines mentioned. Resolve relative refs against the session date. null resolvedDate if too vague to resolve.
- followUp: an explicit next step the user stated, or null`;

const CLAIMS_SYSTEM_PROMPT = `You extract DURABLE PERSONAL FACTS about Kevin from a transcript. Reply ONLY with JSON matching:
{"claims":[{"topic":"<short-kebab-topic>","claim":"<one declarative sentence>","confidence":<0..1>,"domain":"<one of the domains below>"}, ...]}

This transcript is LIKELY DOMINATED BY SOFTWARE ENGINEERING — on Robin itself or on Kevin's other projects. Do NOT extract engineering artifacts or state: code, functions, files, configs, bugs, commits, architecture, libraries, tools, build systems, schemas, or Robin's own internals. Those are NOT memory.

Extract ONLY facts that belong to one of these personal domains, and tag each with its "domain":
- health — medical, fitness, sleep, body, conditions, medications
- finance — accounts, investments, taxes, purchases, income
- career — job, role, employer, work history, professional goals
- relationships — family, friends, social ties
- preferences — tastes, opinions, likes/dislikes (food, media, style)
- creative — photography, gear, creative practice and hobby projects
- travel — trips taken or planned, places visited
- home — residence, household, possessions
- life_events — milestones, personal schedule, plans of personal significance
- identity — background, traits, worldview, who Kevin is
- directives — a STANDING rule Kevin sets for how he works or how Robin should behave (durable workflow/tooling preference), e.g. "commit as kevin.kik.lee@gmail.com", "pnpm dev:log is the required dev command". NOT a one-time task about the current code ("refactor X to use zod") and NOT a transient build state.

Rules:
- A claim must still be true in a future session. When a personal fact appears IN PASSING during technical work, KEEP it and tag its domain.
- If a fact does not fit one of the domains above, OMIT it — do not invent a domain.
- topic: a short kebab-case key (e.g. "google-role", "home-location", "primary-camera").
- confidence: your 0..1 confidence that this is a durable, correct fact.
If nothing durable and personal is present, reply {"claims":[]}.`;

// Hard cap on candidate claims drafted per session — keeps a chatty model from
// flooding the review queue from a single transcript.
const MAX_CLAIMS_PER_SESSION = 20;

/**
 * Run the claim-drafting pass on a single chunk. Individually timeout-bounded by
 * the caller's chunk timeout and capped at a small maxTokens so it can never blow
 * the tick.
 *
 * Distinguishes "no durable claims" from "the model's output didn't parse"
 * (spec §C3, decision 5): a parse throw or a schema-validation failure returns
 * `{ claims: [], failure: '<reason>' }`, while a clean empty extraction returns
 * `{ claims: [] }` with no `failure`. The `withTimeout` reject (and any other
 * invoke throw) still propagates OUT — the chunk loop's catch turns those into
 * dead letters too.
 */
export async function extractClaims(
  llm: LLMDispatcher,
  chunkText: string,
  timeoutMs: number,
  label: string,
): Promise<ExtractClaimsOutcome> {
  const inv = await withTimeout(
    llm.invoke('reasoning', {
      systemPrompt: CLAIMS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: chunkText }],
      temperature: 0,
      maxTokens: 2048,
    }),
    timeoutMs,
    label,
  );
  const jsonText = inv.text
    .trim()
    .replace(/^```(?:json)?/, '')
    .replace(/```$/, '')
    .trim();
  let parsed: ReturnType<typeof claimsSchema.safeParse>;
  try {
    parsed = claimsSchema.safeParse(JSON.parse(jsonText));
  } catch (err) {
    return {
      claims: [],
      failure: `json parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed.success)
    return { claims: [], failure: `schema: ${parsed.error.message.slice(0, 200)}` };
  return { claims: parsed.data.claims };
}

/**
 * Upsert a claim-extraction dead letter (spec §C3). `attempts` counts tries: the
 * first failure inserts 1, a retry that fails again bumps it. The chunk body is
 * stored VERBATIM so a retry never depends on the chunker reproducing identical
 * boundaries across code changes. `last_error` is truncated to keep the row small.
 */
function recordClaimFailure(
  db: RobinDb,
  eventId: number,
  chunkIdx: number,
  chunkBody: string,
  error: string,
): void {
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, last_error)
     VALUES (?,?,?,?)
     ON CONFLICT(event_id, chunk_idx) DO UPDATE SET
       attempts = attempts + 1, last_error = excluded.last_error, ts = datetime('now')`,
  ).run(eventId, chunkIdx, chunkBody, error.slice(0, 500));
}

// ─── Dead-letter retry pass (§C3) ───────────────────────────────────────────────
// "Open" = attempts < 3 (decision 6): a chunk gets at most 3 extraction tries
// before it becomes an exhausted audit record. The retry pass drains a bounded
// slice of open rows per tick, keeps exhausted rows 30 days for forensics, then
// raises a Phase-A backlog alert whose resolution path is the same pass (the
// alert resolves the moment the open count drops back to the threshold).

/** A chunk is retried at most this many times before it becomes an audit record. */
const CLAIM_RETRY_MAX_ATTEMPTS = 3;
/** Open dead letters re-attempted per retry pass (bounds the end-of-tick LLM spend). */
const CLAIM_RETRY_PER_PASS = 5;
/** Open-backlog size above which the Phase-A alert fires. */
const CLAIM_BACKLOG_ALERT_THRESHOLD = 10;
/** Exhausted (attempts >= max) rows older than this are pruned by the retry pass. */
const CLAIM_FAILURE_RETENTION_DAYS = 30;

export interface ClaimRetryResult {
  /** Open rows re-attempted this pass (bounded by CLAIM_RETRY_PER_PASS). */
  retried: number;
  /** Re-attempts that re-extracted cleanly and cleared their dead-letter row. */
  recovered: number;
  /** Open rows (attempts < max) remaining after the pass — the raw queue depth. */
  openBacklog: number;
  /**
   * Open rows whose latest error is a genuine extraction failure (parse/schema/
   * timeout), EXCLUDING rows deferred purely by a hard LLM outage (subscription
   * limit / spend cap). Drives the backlog alert: a usage-limit window can
   * dead-letter a whole session's remaining chunks at once to PRESERVE their
   * claims for re-extraction (160 chunks on 2026-06-15) — those rows are waiting
   * for the account to come back, not failing, and must not raise a "chunks
   * failing" alarm. They still get retried + cleared by the next healthy pass.
   */
  genuineBacklog: number;
}

/**
 * Drain the claim dead-letter queue (spec §C3). Re-extract up to
 * `CLAIM_RETRY_PER_PASS` open rows (attempts < `CLAIM_RETRY_MAX_ATTEMPTS`),
 * oldest first, against the same claim-extraction prompt:
 *
 *   - Success → each claim enters the normal candidate pipeline
 *     (`insertCandidateWithDedup`) and the dead-letter row is DELETED. The
 *     candidate's provenance is RECOMPUTED per row from the source event's kind
 *     (the same `classifyProvenance([kind])` path the original extraction used),
 *     never hardcoded — a retried first-party chunk must stay first-party.
 *   - A returned `failure` or a thrown error → `recordClaimFailure` bumps
 *     `attempts` (the upsert), so a chronically-bad chunk exhausts and stops
 *     being retried.
 *
 * Exhausted rows are kept `CLAIM_FAILURE_RETENTION_DAYS` as audit, then pruned
 * here. A backlog of more than `CLAIM_BACKLOG_ALERT_THRESHOLD` open rows opens a
 * Phase-A warning alert; the same pass resolves it once the backlog drains —
 * event-driven alerts must carry their own resolution path. Alert writes are
 * wrapped so an alerting failure can never break the retry pass.
 */
export async function retryClaimFailures(
  db: RobinDb,
  llm: LLMDispatcher,
  opts?: { chunkTimeoutMs?: number; max?: number },
): Promise<ClaimRetryResult> {
  const max = opts?.max ?? CLAIM_RETRY_PER_PASS;
  const timeoutMs = opts?.chunkTimeoutMs ?? BIOGRAPHER_CHUNK_TIMEOUT_MS;
  const rows = db
    .prepare(
      `SELECT id, event_id, chunk_idx, chunk_body FROM claim_failures
        WHERE attempts < ? ORDER BY ts ASC, id ASC LIMIT ?`,
    )
    .all(CLAIM_RETRY_MAX_ATTEMPTS, max) as Array<{
    id: number;
    event_id: number;
    chunk_idx: number;
    chunk_body: string;
  }>;

  const result: ClaimRetryResult = { retried: 0, recovered: 0, openBacklog: 0, genuineBacklog: 0 };
  for (const row of rows) {
    result.retried++;
    try {
      const { claims, failure } = await extractClaims(
        llm,
        row.chunk_body,
        timeoutMs,
        `claim-retry event=${row.event_id} chunk=${row.chunk_idx}`,
      );
      if (failure) {
        recordClaimFailure(db, row.event_id, row.chunk_idx, row.chunk_body, failure);
        continue;
      }
      // Recompute provenance the way the original extraction did: from the source
      // event's kind, not a hardcoded class (the source event may be first-party).
      const sourceEventRow = db.prepare(`SELECT kind FROM events WHERE id = ?`).get(row.event_id) as
        | { kind: string }
        | undefined;
      const provenance = classifyProvenance(sourceEventRow ? [sourceEventRow.kind] : []);
      for (const c of claims) {
        if (!c.topic?.trim() || !c.claim?.trim()) continue;
        await insertCandidateWithDedup(db, llm, {
          topic: c.topic,
          claim: c.claim,
          confidence: c.confidence ?? null,
          sourceEventId: row.event_id,
          provenance,
        });
      }
      db.prepare(`DELETE FROM claim_failures WHERE id = ?`).run(row.id);
      result.recovered++;
    } catch (err) {
      // Hard outage (subscription limit / spend cap): no row can recover this
      // pass, and recording would consume one of the chunk's bounded retry
      // attempts for a failure that says nothing about the chunk. Stop cold.
      if (isHardLlmOutage(err)) break;
      recordClaimFailure(
        db,
        row.event_id,
        row.chunk_idx,
        row.chunk_body,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Prune exhausted audit rows past retention.
  db.prepare(
    `DELETE FROM claim_failures
      WHERE attempts >= ? AND datetime(ts) < datetime('now', ?)`,
  ).run(CLAIM_RETRY_MAX_ATTEMPTS, `-${CLAIM_FAILURE_RETENTION_DAYS} days`);

  // Backlog alert with its own resolution path (decision 6). Two counts:
  //  - openBacklog: every open row (attempts < max) — the raw queue depth.
  //  - genuineBacklog: open rows MINUS those deferred purely by a hard LLM outage
  //    (last_error matches the subscription-limit / spend-cap signature). The
  //    alert is driven by genuineBacklog so a usage-limit window can't trip a
  //    misleading "chunks failing" warning for chunks that are merely waiting for
  //    the account to come back (it built a 193-row backlog on 2026-06-15→16,
  //    nearly all throttle deferrals, and fired a false alarm). `coalesce` so a
  //    NULL last_error counts as a genuine failure rather than being excluded.
  result.openBacklog = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM claim_failures WHERE attempts < ?`)
      .get(CLAIM_RETRY_MAX_ATTEMPTS) as { n: number }
  ).n;
  result.genuineBacklog = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM claim_failures
          WHERE attempts < ?
            AND coalesce(last_error,'') NOT LIKE '%subscription limit%'
            AND coalesce(last_error,'') NOT LIKE '%spend cap exceeded%'`,
      )
      .get(CLAIM_RETRY_MAX_ATTEMPTS) as { n: number }
  ).n;
  try {
    if (result.genuineBacklog > CLAIM_BACKLOG_ALERT_THRESHOLD) {
      recordAlert(db, {
        severity: 'warning',
        source: 'biographer',
        key: 'claim-failures-backlog',
        message: `${result.genuineBacklog} claim-extraction chunks failing (dead-letter backlog)`,
        context: { genuineBacklog: result.genuineBacklog, openBacklog: result.openBacklog },
      });
    } else {
      resolveAlert(db, 'biographer', 'claim-failures-backlog');
    }
  } catch {
    // alerting never breaks the pass
  }

  return result;
}

/**
 * Strip harness / slash-command scaffolding that leaks into captured session
 * bodies but carries ZERO biographical content: the local-command caveat, the
 * /command invocation tags (name/message/args/contents), and command stdout.
 * Every slash-command + skill session begins with these, so they dominated the
 * claim dead-letter queue (74 of 141 chunks on 2026-06-16) — wasting extraction
 * LLM calls and never yielding a durable fact. Stripped BEFORE chunking so a turn
 * that is only scaffolding falls under the per-turn floor and is dropped, never
 * reaching extraction or the queue.
 */
export function stripHarnessScaffolding(body: string): string {
  return body
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<command-contents>[\s\S]*?<\/command-contents>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '');
}

/**
 * Clean a captured session body before LLM extraction. Strips noise that wastes
 * model time, inflates chunk counts, and can trigger model hangs:
 * - Harness/slash-command scaffolding (caveat, command tags, stdout)
 * - Skill-prompt injections (a [USER] turn that is a skill's own system prompt,
 *   recognizable by a leading `# /<skill>` header — NOT user-authored content)
 * - [TOOL] blocks (file reads, bash output, JSON blobs — zero entities)
 * - Code blocks (triple-backtick fences — rarely contain entities)
 * - Consecutive [ASSISTANT] turns collapsed into one (prevents many-turn degeneracy)
 * - Very short turns (<50 chars — "Done.", "Starting." — no entity content)
 */
export function preprocessForExtraction(body: string): string {
  // Drop harness scaffolding before anything else so command-only turns collapse
  // to nothing and get dropped by the <50-char floor below.
  body = stripHarnessScaffolding(body);
  // Split on turn boundaries
  const turns = body.split(/\n\n(?=\[(?:USER|ASSISTANT|TOOL)\]\n)/);

  // Count assistant turns — if many (>10), the session is likely an automated
  // audit/refactor with dense mechanical steps that can hang the model. In that
  // case, keep only USER turns + the LAST assistant turn (the summary/conclusion).
  const assistantTurns = turns.filter((t) => /^\[ASSISTANT\]/i.test(t));
  const aggressive = assistantTurns.length > 10;

  const kept: string[] = [];
  let lastRole = '';
  let lastAssistantIdx = -1;

  // Find the index of the last assistant turn (for aggressive mode)
  if (aggressive) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (/^\[ASSISTANT\]/i.test(turns[i])) {
        lastAssistantIdx = i;
        break;
      }
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    // Drop [TOOL] blocks entirely
    if (/^\[TOOL\]\n/i.test(turn)) continue;

    // In aggressive mode, drop intermediate assistant turns (keep only the last)
    if (aggressive && /^\[ASSISTANT\]/i.test(turn) && i !== lastAssistantIdx) continue;

    // Strip triple-backtick code blocks within turns
    const stripped = turn.replace(/```[\s\S]*?```/g, '').trim();

    // Drop very short turns (after code removal)
    const contentAfterMarker = stripped.replace(/^\[(?:USER|ASSISTANT|TOOL)\]\n/, '');
    if (contentAfterMarker.length < 50) continue;

    // Drop skill / agent SYSTEM-PROMPT injections captured as [USER] turns — they
    // are instructions, not user-authored biography. Two shapes seen in the queue
    // on 2026-06-16 (53 rows total): slash-command skills open with a `# /<skill>`
    // header; skill + agent prompts open with a second-person role assignment
    // ("You are the MONEY analyst…", "You are critiquing…", "You are a professional
    // color grading assistant…"). The role-assignment list is scoped to role nouns
    // so it can't swallow conversational "You are right/wrong/sure". This also
    // catches Robin's OWN dream-synthesis specialist + nightly-critique prompts,
    // which loop back into memory via self-capture.
    if (
      /^#\s*\/[a-z0-9][\w:-]*/i.test(contentAfterMarker) ||
      /^You are (the|a|an|Kevin'?s|running|critiquing|composing)\b/i.test(contentAfterMarker)
    )
      continue;

    // Collapse consecutive same-role turns
    const roleMatch = stripped.match(/^\[(USER|ASSISTANT|TOOL)\]/i);
    const role = roleMatch ? roleMatch[1].toUpperCase() : '';
    if (role === lastRole && role === 'ASSISTANT' && kept.length > 0) {
      kept[kept.length - 1] += `\n${contentAfterMarker}`;
    } else {
      kept.push(stripped);
      lastRole = role;
    }
  }

  return kept.join('\n\n');
}

/**
 * Split a captured session body on turn boundaries into chunks of <= maxChars.
 * Body shape (from capture.ts): `[ROLE]\n<content>` separated by `\n\n`.
 * Returns the original body in a single-element array if it already fits.
 * A single turn longer than maxChars is sliced — no turn can block progress.
 */
export function chunkBody(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];
  const turns = body.split(/\n\n(?=\[(?:USER|ASSISTANT|TOOL)\]\n)/);
  const chunks: string[] = [];
  let current = '';
  for (const turn of turns) {
    if (turn.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < turn.length; i += maxChars) {
        chunks.push(turn.slice(i, i + maxChars));
      }
      continue;
    }
    if (current && current.length + 2 + turn.length > maxChars) {
      chunks.push(current);
      current = turn;
    } else {
      current = current ? `${current}\n\n${turn}` : turn;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Larger chunks = fewer LLM round-trips per session (less repeated system-prompt
// processing, fewer merge/disambiguation passes). 10k chars (~2.5k tokens) leaves
// ample headroom under qwen3's 32k context even with the system prompt. Raised
// from 6000 on 2026-05-23 to cut the per-session chunk count ~40% during a large
// backlog drain. NOTE: changing this invalidates in-flight biographer_progress
// cursors (they index chunks at the old size) — clear that table when changing it.
const CHUNK_CHARS = 20000;

// Multi-tick bound — the biographer processes at most this many chunks per
// `runBiographer` call, persisting a cursor in `biographer_progress` so a large
// session resumes on the next cron tick. This is the structural fix for the
// restart loop: previously a session was processed all-or-nothing in one tick,
// so any session whose cumulative chunk-time exceeded the daemon's 30-min
// sustained-CRITICAL gate could never complete — the daemon force-restarted
// mid-session and re-claimed the same row forever. With a per-tick cap, no
// session (regardless of size) can hold the scheduler past the gate. 10 chunks ×
// the 2-min per-chunk ceiling = 20 min worst case (under the 30-min gate).
// With maxTokens=4096, real chunks finish in ~77s, so a tick takes ~13 min.
// Temporarily raised to 30 for the May backlog drain; reverted to 10 on
// 2026-06-12 after the self-capture purge cut the queue to ~200 real sessions
// (each chunk ≈ 5-10s on Sonnet via the claude-agent provider).
const MAX_CHUNKS_PER_TICK = 10;

// Sanity ceiling — sessions whose body exceeds this are skipped with a
// `biographer.extracted` marker so they stop being re-selected. This used to be
// the *stability* floor (200k), because a large session would restart-loop the
// daemon. Multi-tick processing (MAX_CHUNKS_PER_TICK) removed that failure mode:
// a large session now drains safely across many ticks. So this is now just a
// guard against pathological inputs (e.g. a multi-MB tool-output paste) that
// would monopolize the biographer for many hours. 1M chars ≈ 167 chunks ≈ 42
// ticks at */15 — generous enough to cover every real capture observed
// (largest: ~501k) while still rejecting absurd outliers.
const MAX_SESSION_BODY_CHARS = 1_000_000;

// Sessions under this floor are skipped with an empty extraction marker.
// Very short sessions (debugging one-liners, tool-only invocations) rarely
// contain entities worth extracting; skipping them saves ~80s/session of LLM
// time and avoids injecting noise into the graph.
const MIN_SESSION_BODY_CHARS = 1_000;

const disambiguationSchema = z.object({
  matched_id: z.number().int().nullable(),
  create_new: z.boolean(),
  reason: z.string(),
});

interface DisambiguationContext {
  type: string;
  name: string;
  sourceText: string;
}

export interface BiographerRunResult {
  processed: number;
  entitiesCreated: number;
  relationsCreated: number;
  /** Candidate beliefs drafted into the review queue (second pass). */
  claimsDrafted: number;
  /** Claims dropped by the personal-domain allowlist gate (Phase D). */
  claimsDropped: number;
  /** Sessions enriched with intent/outcome/topics via finalization. */
  sessionsSummarized: number;
  /** Cross-session thread links created via topic overlap. */
  sessionsLinked: number;
  errors: string[];
}

export interface RunBiographerOptions {
  /** Per-chunk extraction LLM timeout. Defaults to `BIOGRAPHER_CHUNK_TIMEOUT_MS`. */
  chunkTimeoutMs?: number;
  /** Per-entity disambiguation LLM timeout. Defaults to `DISAMBIGUATION_TIMEOUT_MS`. */
  disambiguationTimeoutMs?: number;
  /** Max chunks to extract per call before persisting progress. Defaults to `MAX_CHUNKS_PER_TICK`. */
  maxChunksPerTick?: number;
  /** Body-size ceiling above which a fresh session is skipped. Defaults to `MAX_SESSION_BODY_CHARS`. */
  maxSessionBodyChars?: number;
  /** Body-size floor below which a fresh session is skipped. Defaults to `MIN_SESSION_BODY_CHARS`. */
  minSessionBodyChars?: number;
  /** How many non-tool chunks to batch per LLM invoke (amortizes thinking overhead). Defaults to 1 (no batching). */
  batchChunks?: number;
  /** Skip chunks that are pure tool/assistant output (no [USER] marker). Defaults to false. */
  skipToolChunks?: boolean;
  /**
   * Run the second-pass claim-drafting extraction (durable declarative facts →
   * belief_candidates queue). Defaults to false here; production wiring
   * (jobs.ts) defaults it to the `biographer.draftClaims` config flag (true).
   */
  draftClaims?: boolean;
  /**
   * Phase D personal-domain allowlist gate. When true (default), claims/entities
   * outside PERSONAL_DOMAINS are dropped at extraction. Resolved from the
   * `biographer.domainGating` policy at handler time (mirrors `draftClaims`).
   */
  domainGating?: boolean;
  /**
   * Overall wall-clock budget for the whole tick. Once exceeded, the session
   * loop stops claiming further sessions and returns gracefully (per-chunk
   * progress is already persisted, so the next cron tick resumes). This caps a
   * heavy backlog drain (limit=30) so it can't overrun the scheduler's
   * HANDLER_TIMEOUT_MS and get hard-errored mid-flight. Omit to disable.
   * Within a single session, `maxChunksPerTick` + the per-chunk timeout remain
   * the bound; this guards the across-sessions dimension.
   */
  tickDeadlineMs?: number;
  /** Injectable clock for the tick deadline (testing). Defaults to `Date.now`. */
  now?: () => number;
}

type EntityRecord = { type: string; name: string };
type RelationRecord = { subject: string; predicate: string; object: string };

/**
 * Canonicalize a relation predicate so variant phrasings of the same relationship
 * don't produce duplicate edges. Maps synonym clusters to a single canonical form.
 */
const PREDICATE_SYNONYMS: Record<string, string> = {
  employed_by: 'works_at',
  employed_at: 'works_at',
  works_for: 'works_at',
  resides_at: 'lives_in',
  resides_in: 'lives_in',
  located_at: 'located_in',
  possesses: 'owns',
  has: 'owns',
  utilizes: 'uses',
  employs: 'uses',
  leverages: 'uses',
  wrote: 'authored',
  created: 'authored',
  developed: 'authored',
  built: 'authored',
  purchased: 'bought',
  acquired: 'bought',
  visited: 'traveled_to',
  went_to: 'traveled_to',
  manages: 'leads',
  supervises: 'leads',
  prescribed: 'takes',
  taking: 'takes',
  co_founded: 'co-founded',
  cofounded: 'co-founded',
};

export function normalizePredicate(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return PREDICATE_SYNONYMS[trimmed] ?? trimmed;
}

function entityKey(e: EntityRecord): string {
  return `${e.type.toLowerCase()}:${e.name.toLowerCase()}`;
}

function relationKey(r: RelationRecord): string {
  return `${r.subject.toLowerCase()}:${r.predicate.toLowerCase()}:${r.object.toLowerCase()}`;
}

interface BiographerTarget {
  eventId: number;
  body: string;
  /** Next chunk index to process (0 for a fresh session). */
  nextChunk: number;
  /** True if a `biographer_progress` row already exists (a resumed session). */
  isResume: boolean;
  entities: Map<string, EntityRecord>;
  relations: Map<string, RelationRecord>;
}

/**
 * Pick the session to work on this tick. An in-progress session (one with a
 * `biographer_progress` row whose cursor hasn't reached the end) takes priority
 * so partially-extracted work always finishes before a new session is started.
 * Otherwise the newest unprocessed `session.captured` event is selected.
 */
function selectBiographerTarget(db: RobinDb): BiographerTarget | null {
  const resume = db
    .prepare(`
      SELECT bp.source_event_id AS eventId, bp.next_chunk AS nextChunk,
             bp.entities_json AS entitiesJson, bp.relations_json AS relationsJson,
             events_content.body AS body
        FROM biographer_progress bp
        JOIN events ON events.id = bp.source_event_id
        JOIN events_content ON events_content.id = events.content_ref
       WHERE bp.next_chunk < bp.total_chunks
       ORDER BY bp.created_at
       LIMIT 1
    `)
    .get() as
    | {
        eventId: number;
        nextChunk: number;
        entitiesJson: string;
        relationsJson: string;
        body: string;
      }
    | undefined;

  if (resume) {
    const entities = new Map<string, EntityRecord>();
    const relations = new Map<string, RelationRecord>();
    try {
      for (const e of JSON.parse(resume.entitiesJson) as EntityRecord[])
        entities.set(entityKey(e), e);
      for (const r of JSON.parse(resume.relationsJson) as RelationRecord[])
        relations.set(relationKey(r), r);
    } catch {
      // Corrupted progress JSON — start the session over with empty accumulators.
      // The chunks will be re-extracted from nextChunk onward.
    }
    return {
      eventId: resume.eventId,
      body: resume.body,
      nextChunk: resume.nextChunk,
      isResume: true,
      entities,
      relations,
    };
  }

  const fresh = db
    .prepare(`
      SELECT events.id AS eventId, events_content.body AS body
        FROM events
        JOIN events_content ON events_content.id = events.content_ref
       WHERE events.kind IN ('session.captured', 'knowledge.doc', 'conversation.claude-code')
         AND COALESCE(json_extract(events.payload, '$.category'), 'personal') != 'dev'
         AND events.id NOT IN (SELECT json_extract(payload, '$.source_event_id') FROM events WHERE kind = 'biographer.extracted')
         AND events.id NOT IN (SELECT source_event_id FROM biographer_progress)
       ORDER BY length(events_content.body) ASC
       LIMIT 1
    `)
    .get() as { eventId: number; body: string } | undefined;

  if (!fresh) return null;
  return {
    eventId: fresh.eventId,
    body: fresh.body,
    nextChunk: 0,
    isResume: false,
    entities: new Map(),
    relations: new Map(),
  };
}

function saveBiographerProgress(
  db: RobinDb,
  eventId: number,
  totalChunks: number,
  nextChunk: number,
  entities: Map<string, EntityRecord>,
  relations: Map<string, RelationRecord>,
): void {
  db.prepare(`
    INSERT INTO biographer_progress (source_event_id, total_chunks, next_chunk, entities_json, relations_json, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_event_id) DO UPDATE SET
      total_chunks = excluded.total_chunks,
      next_chunk = excluded.next_chunk,
      entities_json = excluded.entities_json,
      relations_json = excluded.relations_json,
      updated_at = excluded.updated_at
  `).run(
    eventId,
    totalChunks,
    nextChunk,
    JSON.stringify([...entities.values()]),
    JSON.stringify([...relations.values()]),
  );
}

function writeExtractedMarker(
  db: RobinDb,
  eventId: number,
  entities: number,
  relations: number,
): void {
  db.prepare(`
    INSERT INTO events (ts, kind, source, status, payload)
    VALUES (?, 'biographer.extracted', 'biographer', 'ok', ?)
  `).run(
    new Date().toISOString(),
    JSON.stringify({ source_event_id: eventId, entities, relations }),
  );
}

// Kevin-context: the biographer knows WHO the user is, so it picks the right
// entity types (Nikon Zf → gear, not thing; Antonucci Cafe → restaurant, not org).
const USER_CONTEXT = `Context: The user is Kevin, a Google DevRel engineer (Ad Experiences, NYC), photographer (Nikon Zf/Z50 II, street + events), and investor. He lives in Astoria, Queens. Key domains: finance (RSUs, 401k, HYSA, Lunch Money), health (Whoop, running), birding (eBird, Central Park), music (Spotify, Last.fm), photography (Lightroom), and software projects (Robin, leadforge, hostmind, photo-tools).`;

const SYSTEM_PROMPT = `You extract structured entities and relations from a transcript about Kevin's life. Reply ONLY with JSON matching:
{"entities":[{"type":"<type>","name":"..."}, ...], "relations":[{"subject":"name","predicate":"verb","object":"name"}, ...]}

${USER_CONTEXT}

Valid <type> values (use the MOST SPECIFIC that fits):
  person, place, restaurant, organization, company, service, product, gear,
  camera, lens, financial_account, medication, event, project, library, tool,
  book, film, album, artist, song, species, topic, thing.
Use "thing" ONLY when nothing more specific applies. Examples:
  "Nikon Zf" → gear (not thing), "Antonucci Cafe" → restaurant (not organization),
  "Marcus HYSA" → financial_account, "Three.js" → library, "Olive-sided Flycatcher" → species,
  "Google I/O" → event, "ibuprofen" → medication, "Free Bird" → song (not thing),
  "Pet Sounds" → album (not thing).

Relation rules:
- Use a SPECIFIC, MEANINGFUL predicate — a verb phrase describing a real directed
  relationship (e.g. "lives_in", "works_at", "owns", "photographed_at", "prescribed").
- Subject = the actor/owner; object = the target/thing acted upon. Always maintain
  this direction so "Kevin works_at Google" and "Google employs Kevin" aren't both
  emitted — pick one canonical direction (prefer Kevin as subject for his actions).
- Do NOT use vague co-occurrence predicates: "related_to", "associated_with",
  "mentioned_with", "appears_with", "occurs_with". If no clear directed
  relationship exists, omit the relation entirely.
- NORMALIZE predicates to a canonical form: use "works_at" not "employed_by",
  "lives_in" not "resides_at", "owns" not "possesses", "uses" not "utilizes".

Do NOT extract:
- Transcript role markers (USER, ASSISTANT, TOOL, SYSTEM).
- Bare numbers, state flags (ON, OFF, TRUE, FALSE, ENABLED, DISABLED), git SHAs.
- Single-character or empty names.
- Engineering artifacts: commit messages, PR titles, build flags, task/phase codenames,
  subagent instructions, code variable names, schema fields, CLI flags.
- Robin's own internals: job schedules, daemon behavior, integration wiring, env vars.

If nothing is worth extracting, reply {"entities":[],"relations":[]}.`;

/**
 * Defensive filter applied AFTER LLM extraction to drop noise that the model
 * sometimes emits despite the prompt rules above. The prompt is a soft contract;
 * this is the hard one. Returning true means "drop this entity".
 *
 * `type` is optional (back-compat with name-only callers) but, when supplied,
 * unlocks a stricter pass for the noise-prone types `thing`/`error`/`topic`:
 * coding-session captures routinely yield engineering-internal artifacts
 * (`lock-cleanup`, `PID-liveness`, `CI on main`, `learning-queue.md over cap`,
 * bare verbs like `Disagree`) that have no real-world referent and only pollute
 * Kevin's personal memory graph. Concrete types (person/place/organization/
 * service/repository/tool/env_var) are NOT subjected to that pass, so
 * legitimate kebab-case repos (`landstar-construction`) and services (`OpenTable`)
 * survive. (`library` is dropped wholesale by BLOCKED_ENTITY_TYPES — see below.)
 *
 * Companion: any relation whose subject or object matches a dropped entity is
 * also dropped (a relation pointing at noise is itself noise).
 */
export function isLowQualityEntity(name: string, type?: string): boolean {
  // ─── Blocked types: dev/engineering-internal ─────────────────────────────
  // These entity types are inherently about code, not the user's life. Blocking
  // them at extraction time is the structural prevention that keeps dev noise out
  // of user-data. The biographer's LLM freely assigns these types from coding
  // sessions; we drop them wholesale. Real-world things that occasionally share a
  // type name (e.g. a photography "tool") get captured under `thing`/`topic` by
  // the LLM anyway, so the loss is negligible.
  if (type && BLOCKED_ENTITY_TYPES.has(type.toLowerCase())) return true;

  const trimmed = name?.trim() ?? '';
  if (trimmed.length < 2 || trimmed.length > 200) return true;
  // Pure numbers (e.g. "10", "404") — usually counters, status codes, or version
  // fragments captured out of context. If a real entity needs a number, it should
  // have surrounding words ("HTTP 404").
  if (/^[0-9]+$/.test(trimmed)) return true;
  // Git SHA fragment — 7-40 hex chars, no other content.
  if (/^[a-f0-9]{7,40}$/i.test(trimmed)) return true;
  // Transcript role markers — appear in chunked bodies like "[USER]\n..." and
  // sometimes get extracted as entities. Match case variants.
  const lower = trimmed.toLowerCase();
  if (ROLE_MARKER_NAMES.has(lower)) return true;
  // Boolean / state-flag tokens. Length-gated to avoid clobbering legitimate
  // entities like "Disabled by maintenance window" — only catch the bare flag.
  if (STATE_FLAG_NAMES.has(lower) && trimmed.length <= 10) return true;
  // Generic programming nouns + Claude Code tool names — high-frequency words
  // with no entity value ("file", "config", "data", "Read", "Bash", "TodoWrite").
  if (GENERIC_NOISE_NAMES.has(lower)) return true;
  // Money amounts ("$120", "$2,900/mo", "$300-554/mo") — transaction figures, not entities.
  if (/^\$[\d,]/.test(trimmed)) return true;
  // CLI flags ("--force", "--skip-mcp").
  if (/^--/.test(trimmed)) return true;
  // Dotfiles / extension fragments (".env", ".git", ".com", ".nvmrc").
  if (/^\./.test(trimmed)) return true;
  // All-lowercase snake_case = code variables ("opt_out_requested", "send_channel").
  // Uppercase/mixed snake (VERCEL_OIDC_TOKEN) is a legit env-var entity, so keep it.
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(trimmed)) return true;
  // File paths / npm package names / repo slugs: whitespace-free tokens with a
  // path structure — ≥2 slashes, an @scope or ./ / leading prefix, or a file
  // extension. Single-slash tech shorthand ("CI/CD", "TCP/IP", "A/B") is spared.
  if (
    !/\s/.test(trimmed) &&
    /\//.test(trimmed) &&
    ((trimmed.match(/\//g)?.length ?? 0) >= 2 ||
      /^[@/]/.test(trimmed) ||
      /\.\w{1,5}$/.test(trimmed))
  ) {
    return true;
  }
  // Source-file references with an extension ("learning-queue.md", "biographer.ts",
  // "dream.test.ts") — dev/build artifacts, never real-world entities. Caught even
  // when embedded in a phrase ("learning-queue.md over cap"). The path heuristic
  // above only fires on slash-bearing tokens, so this covers bare file names.
  // JS frameworks follow a `<Capitalized>.js` convention (Three.js, Next.js,
  // Node.js, Discord.js, NextAuth.js) — real entities, NOT source-file refs.
  // Exempt them from the file-extension heuristic; lowercase/hyphenated source
  // files ("event-bus.js") and non-.js files ("biographer.ts", "Board.tsx") are
  // still caught.
  const isFrameworkName = /^[A-Z][a-zA-Z0-9]*\.js\b/.test(trimmed);
  if (
    !isFrameworkName &&
    /(^|\s)[\w.-]+\.(md|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|sql|sh|py|toml|log|ndjson|csv|html|plist|nef|cr[23]|arw|raf|orf|dng)(\s|$|:)/i.test(
      trimmed,
    )
  )
    return true;
  // Image/media filenames (DSC_1234.jpg, IMG_001.png, screenshot.gif).
  if (/(^|\s)[\w.-]+\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|wav|mp3|pdf|zip|tar)(\s|$)/i.test(trimmed))
    return true;
  // IP addresses / localhost.
  if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(trimmed)) return true;
  // Robin internal state keys (runtime:*, batch(*), entities:*).
  if (/^(runtime|batch|entities|events|integration|cognition)[:(]/.test(trimmed)) return true;
  // MCP tool names (mcp__robin__recall, mcp__robin__*, mcp__chrome-devtools__*).
  if (/^mcp__/.test(trimmed)) return true;
  // Robin's own launchd job labels (io.robin-assistant.daemon, .backup) — reverse-DNS
  // identifiers for the system's own processes, never a real-world entity whatever
  // type the LLM assigns. Self-referential capture from Robin's own dev sessions.
  if (/^io\.robin-assistant\b/i.test(trimmed)) return true;
  // Decimal numbers without context ("0.62", "3.14") — not entities.
  if (/^\d+\.\d+$/.test(trimmed)) return true;
  // ISO dates ("2026-06-09", "2026-12-31", "1989-09-08") — calendar references, not entities.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return true;
  // Year-month fragments ("2026-06").
  if (/^\d{4}-\d{2}$/.test(trimmed)) return true;
  // Phone numbers ("201-321-5446", "(201) 321-5446").
  if (/^[\d(][\d() -]{7,15}$/.test(trimmed) && (trimmed.match(/\d/g)?.length ?? 0) >= 7)
    return true;
  // Physical measurements ("6.4 mm x 4.5 mm", "2.5 x 1.6 cm", "24.5MP", "9 rounded aperture blades").
  if (/^\d+(\.\d+)?\s*(mm|cm|m|MP|mp|px|BPM|bpm|HU|hu|kg|lbs|lb|oz|°F|°C)\b/.test(trimmed))
    return true;
  // Dimension strings ("6.4 mm x 4.5 mm").
  if (/^\d+(\.\d+)?\s*(mm|cm|m)?\s*x\s*\d/i.test(trimmed)) return true;
  // Body-metric fragments ("recovery 78%", "65 BPM", "80HU").
  if (/^\d+(\.\d+)?%$/.test(trimmed)) return true;
  if (/^recovery\s+\d/i.test(trimmed)) return true;
  // Vague temporal fragments ("~July", "~March 2026").
  if (/^~/.test(trimmed)) return true;
  // Bare aperture/focal-length fragments without a brand ("100-400mm", "120mm corner softness").
  if (/^\d+-?\d*mm\b/.test(trimmed)) return true;

  // ─── Type-aware engineering-internal pass ─────────────────────────────────
  // Only the noise-prone, low-specificity types. Concrete types (person, place,
  // organization, service) are spared so a real service that happens to read
  // like jargon ("OpenTable") is never dropped here.
  if (type && DEV_NOISE_TYPES.has(type.toLowerCase())) {
    // camelCase identifiers (fetchHistory, redactString, sessionIds) — code
    // function/variable names. Real-world entities are never camelCase.
    if (/^[a-z]+[A-Z]/.test(trimmed)) return true;
    // PascalCase multi-word without spaces (CreatePrivateThreads,
    // UpsertProfileOpts) — code class/type names. Not natural language.
    // Single PascalCase words are exempt (could be a proper noun like "Datadog").
    if (/^[A-Z][a-z]+[A-Z][a-zA-Z]+$/.test(trimmed) && !/\s/.test(trimmed)) return true;
    // Dev/build jargon: CI/CD, lock/PID/dispatch/cron/daemon/cursor/script/hash/
    // protocol/queue/cap process-internals. Word-boundary matched so it only
    // fires on the jargon token, not any substring (e.g. won't hit "Pidgeon").
    if (DEV_JARGON_RE.test(trimmed)) return true;
    // Bare conversational verbs/words with no referent ("Disagree", "Stress Test",
    // "Refactor") — captured as a `topic`/`thing` from a coding back-and-forth.
    // Gated to 1-2 short title/lower-case word tokens so multi-word real topics
    // ("Bergen County zoning", "Nikon Z8 autofocus") are untouched.
    const words = trimmed.split(/\s+/);
    if (words.length <= 2 && words.every((w) => GENERIC_VERB_NOISE.has(w.toLowerCase())))
      return true;
    // Sentence-length "entities" — the LLM sometimes extracts instructions,
    // task descriptions, or commit messages as entity names (e.g. "Implementer
    // subagent fixes quality issues"). Real entity names are short noun phrases.
    if (words.length >= 6) return true;
    // Conventional-commit prefixes: "chore(deps): ...", "feat(linear): ...",
    // "fix(shell): ..." — git commit messages, not entities.
    if (/^(?:chore|feat|fix|refactor|ci|build|docs|style|perf|test)\b/i.test(trimmed)) return true;
    // Project-internal phase/track codenames: "Phase 0", "Phase 4a edge",
    // "Track B Phase 4e", "W2-C", "cognition-e1", "M-shield". These are
    // internal roadmap labels, not real-world entities.
    if (/^(?:Phase|Track|Stage|Sprint|Milestone)\s/i.test(trimmed)) return true;
    // Database table references: "edges table", "refusals table", "users table".
    if (/\b(?:table|column|index|migration|constraint|foreign key)$/i.test(trimmed)) return true;
    // Code output / config values: "output: 'standalone'", "GREEN" (status).
    if (/^output:\s/.test(trimmed)) return true;
    // Import/require statements: "import { ... } from '...'".
    if (/^(?:import|require|export)\s/.test(trimmed)) return true;
  }

  // ─── Type-aware: 'project' type noise ──────────────────────────────────────
  // `project` entities are legitimate when they name a real product ("Palisade
  // Stays", "leadforge") but the LLM also emits internal codenames like
  // "cognition-e1", "Phase 4a edge", "Agentic Form Builder" from dev sessions.
  // Drop project entities whose names are kebab-case with a version/codename
  // suffix — real products use proper-noun casing.
  if (type?.toLowerCase() === 'project') {
    if (/^[a-z][\w-]*-[a-z]\d/i.test(trimmed)) return true; // cognition-e1, phase-4a
    // Internal roadmap codenames mis-typed as projects: "Phase 4a edge",
    // "Track B Phase 1", "M0 Phase A". Real products use proper-noun names.
    if (/^(?:Phase|Track|Stage|Sprint|Milestone)\b/i.test(trimmed)) return true;
    if (/^M\d+\s+Phase\b/i.test(trimmed)) return true;
  }

  return false;
}

// Entity types that are inherently dev/engineering-internal — dropped wholesale by
// isLowQualityEntity so they never enter the graph. Covers code constructs, Robin
// internals, and infrastructure artifacts. Personal entities the LLM might mis-type
// as one of these (e.g. a photography "tool") get re-extracted under `thing`/`topic`.
// Blocked types: purely engineering/code-internal types that never describe
// Kevin's real world. `tool` is NOT blocked — it holds real-world tools (Adobe
// Lightroom, Topaz Photo AI) alongside dev tooling; the noise filter
// (`isLowQualityEntity`) plus the hygiene blocklist handle dev-jargon within it.
//
// `library` IS blocked: in a personal-life memory graph the type only ever names a
// code library (Zod, BullMQ, sqlite-vec, vLLM…) extracted from coding-session
// captures — a physical library is a `place`, a photo-book collection is `book`.
// Observed live: 22/22 `library` entities were code frameworks with zero recall
// value. Real frameworks the LLM still wants to keep get re-typed as `tool`/`thing`.
const BLOCKED_ENTITY_TYPES = new Set([
  'error',
  'env_var',
  'surface',
  'table',
  'directory',
  'function',
  'field',
  'schema',
  'method',
  'command',
  'system_component',
  'pipeline',
  'mechanism',
  'configuration',
  'specification',
  'log',
  'file',
  'database',
  'variable',
  'test case',
  'alias',
  'format',
  'effort_level',
  'attribute',
  'tag',
  'version',
  'os',
  'software',
  'library',
]);

// Types that lack a real-world referent and disproportionately carry dev-internal
// noise out of coding-session captures. Used to gate the stricter heuristics above.
const DEV_NOISE_TYPES = new Set(['thing', 'error', 'topic']);

// Dev/build/process jargon tokens. Word-boundary matched so a legit name that
// merely contains one of these as a substring is unaffected. Catches the observed
// junk class: lock-cleanup, PID-liveness, dispatch hash early-exit, CI on main,
// check-protocol-triggers script missing, learning-queue.md over cap, cron/daemon
// internals. Hyphen and space both count as separators.
const DEV_JARGON_RE =
  /(?:^|[\s-])(?:ci|cd|lock|pid|dispatch|cron|daemon|cursor|script|hash|protocol|liveness|early-exit|launchd|scheduler|tick|heartbeat|stderr|stdout|stacktrace|traceback|queue|backlog|workflow|gitleaks|biographer|disambiguation|chunk|cursor-rule|cache|route|schema|codebase|session-id|handoff|wordmark|webhook|endpoint|middleware|refactor|regex|callback|payload|serializ|deserializ|upsert|backfill|rollback|shim|polyfill|monorepo|turbopack|bundler|transpil|lint|typecheck|monkeypatch|hotfix|bugfix|debounce|throttle|mutex|semaphore|subagent|antipattern|accessor|telemetry|migration|worktree|wrappers|prune|singleton|crud|dream|brief|recall|ingest|primer|intuition|embedder|hygiene|cognition)(?:$|[\s-])/i;

// Single bare verbs / generic non-entities that a model emits as `topic`/`thing`
// from a chat exchange. Kept tight — only words that are never themselves a
// durable real-world entity.
const GENERIC_VERB_NOISE = new Set([
  'disagree',
  'agree',
  'confirm',
  'confirmed',
  'reject',
  'rejected',
  'approve',
  'approved',
  'review',
  'reviewed',
  'refactor',
  'cleanup',
  'fix',
  'fixes',
  'bug',
  'bugs',
  'stress',
  'test',
  'retry',
  'rollback',
  'merge',
  'rebase',
  'commit',
  'revert',
  // Bare generic nouns from dev sessions — no real-world referent on their own.
  'publish',
  'publishing',
  'sync',
  'delete',
  'auditor',
  'notable',
  'proceed',
  'state',
  'first',
]);

// ─── Low-information relation predicates ─────────────────────────────────────
// The LLM emits these as a fallback when two entities co-occur in a transcript
// but have no real directional relationship. They carry zero recall value and
// flood the graph (observed: `occurs_with` alone was 49% of all relations).
// Blocked post-extraction, parallel to BLOCKED_ENTITY_TYPES for entities.
const BLOCKED_PREDICATES = new Set([
  'occurs_with',
  'related_to',
  'associated_with',
  'mentioned_with',
  'appears_with',
  'co-occurs_with',
  'co_occurs_with',
  'linked_to',
  'connected_to',
  'seen_with',
  'alongside',
]);

/**
 * Returns true when a relation predicate is too vague to carry useful meaning.
 * Keeps the graph's signal-to-noise ratio high by blocking co-occurrence
 * fallbacks that the LLM emits when it can't find a real relationship.
 */
export function isLowQualityPredicate(predicate: string): boolean {
  return BLOCKED_PREDICATES.has(predicate.toLowerCase().trim());
}

const ROLE_MARKER_NAMES = new Set(['user', 'assistant', 'tool', 'system', 'human', 'ai']);
// Generic nouns + Claude Code tool names that get mis-extracted as entities.
const GENERIC_NOISE_NAMES = new Set([
  // generic programming/content nouns
  'file',
  'files',
  'code',
  'function',
  'functions',
  'value',
  'values',
  'data',
  'error',
  'errors',
  'test',
  'tests',
  'result',
  'results',
  'output',
  'input',
  'text',
  'line',
  'lines',
  'table',
  'tables',
  'list',
  'lists',
  'item',
  'items',
  'step',
  'steps',
  'note',
  'notes',
  'todo',
  'todos',
  'example',
  'examples',
  'content',
  'config',
  'json',
  'thing',
  'things',
  'stuff',
  'object',
  'objects',
  'field',
  'fields',
  'row',
  'rows',
  'column',
  'columns',
  'string',
  'strings',
  // Claude Code tool names
  'read',
  'edit',
  'write',
  'bash',
  'grep',
  'glob',
  'task',
  'ls',
  'multiedit',
  'todowrite',
  'webfetch',
  'websearch',
  'notebookedit',
  // Generic dev nouns that appear as thing/topic extractions
  'git',
  'widget',
  'widgets',
  'wrappers',
  'handler',
  'handlers',
  'module',
  'modules',
  'token',
  'tokens',
  'endpoint',
  'endpoints',
  'migration',
  'migrations',
  'accessor',
  'accessors',
  'bundle',
  'bundles',
  'payload',
  'payloads',
  'matcher',
  'matchers',
  'matches',
]);
const STATE_FLAG_NAMES = new Set([
  'on',
  'off',
  'yes',
  'no',
  'true',
  'false',
  'enabled',
  'disabled',
  'enable',
  'disable',
  'null',
  'undefined',
]);

/**
 * If multiple candidates exist for the extracted name, ask the LLM to pick one or
 * declare it new. Returns the entity id to use (or null = create new).
 */
export async function disambiguateEntity(
  db: RobinDb,
  llm: LLMDispatcher | null,
  ctx: DisambiguationContext,
  timeoutMs: number = DISAMBIGUATION_TIMEOUT_MS,
): Promise<{ matchedId: number | null; reason: string }> {
  const candidates = findEntity(db, ctx.name, ctx.type);
  if (candidates.length === 0) return { matchedId: null, reason: 'no candidates' };
  if (candidates.length === 1) return { matchedId: candidates[0].id, reason: 'single candidate' };
  if (!llm)
    return {
      matchedId: candidates[0].id,
      reason: 'multiple candidates; LLM unavailable; picked oldest',
    };

  const candidateLines = candidates
    .map(
      (c) =>
        `- id=${c.id}, name="${c.canonical_name}", profile="${(c.profile ?? '').slice(0, 200)}"`,
    )
    .join('\n');
  const systemPrompt = `You disambiguate entity references. Given a name and several candidates, pick which one the source text refers to. Reply ONLY with JSON: {"matched_id": <id> | null, "create_new": <bool>, "reason": "<short>"}. If none fit, set matched_id=null and create_new=true.`;
  const userPrompt = `Source text:\n${ctx.sourceText.slice(0, 2000)}\n\nExtracted: type=${ctx.type}, name="${ctx.name}"\n\nCandidates:\n${candidateLines}`;
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0,
      timeoutMs,
    });
    const text = res.text
      .trim()
      .replace(/^```(?:json)?/, '')
      .replace(/```$/, '')
      .trim();
    const parsed = disambiguationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {
        matchedId: candidates[0].id,
        reason: `LLM returned invalid JSON; fell back to oldest`,
      };
    }
    if (parsed.data.create_new) return { matchedId: null, reason: parsed.data.reason };
    if (parsed.data.matched_id && candidates.some((c) => c.id === parsed.data.matched_id)) {
      return { matchedId: parsed.data.matched_id, reason: parsed.data.reason };
    }
    return { matchedId: candidates[0].id, reason: `LLM picked unknown id; fell back to oldest` };
  } catch {
    return { matchedId: candidates[0].id, reason: 'LLM call failed; fell back to oldest' };
  }
}

// ─── Session finalization ─────────────────────────────────────────────────────

const MAX_FINALIZATION_CHARS = 4000;
const FINALIZATION_SPLIT_CHARS = 3000;

export async function finalizeSession(
  llm: LLMDispatcher,
  target: BiographerTarget,
  chunks: string[],
  extracted: ExtractionResult,
  timeoutMs: number = BIOGRAPHER_CHUNK_TIMEOUT_MS,
): Promise<SessionSummary | null> {
  const sessionTs = (target as BiographerTarget & { ts?: string }).ts ?? new Date().toISOString();

  let contentSection: string;
  if (chunks.length === 1) {
    const text = chunks[0].slice(0, MAX_FINALIZATION_CHARS);
    contentSection = `=== FULL SESSION ===\n${text}`;
  } else {
    const first = chunks[0].slice(0, FINALIZATION_SPLIT_CHARS);
    const last = chunks[chunks.length - 1].slice(0, FINALIZATION_SPLIT_CHARS);
    contentSection = `=== OPENING ===\n${first}\n\n=== CLOSING ===\n${last}`;
  }

  const entityLines = extracted.entities
    .slice(0, 50)
    .map((e) => `${e.type}: ${e.name}`)
    .join('\n');
  const relationLines = extracted.relations
    .slice(0, 30)
    .map((r) => `${r.subject} → ${r.predicate} → ${r.object}`)
    .join('\n');

  const userContent = `Session date: ${sessionTs.slice(0, 10)}\n\n${contentSection}\n\n=== ENTITIES FOUND ===\n${entityLines || '(none)'}\n\n=== RELATIONS FOUND ===\n${relationLines || '(none)'}`;

  const inv = await withTimeout(
    llm.invoke('reasoning', {
      systemPrompt: SESSION_SUMMARY_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: 2048,
    }),
    timeoutMs,
    `biographer-finalize event=${target.eventId}`,
  );

  const jsonText = inv.text
    .trim()
    .replace(/^```(?:json)?/, '')
    .replace(/```$/, '')
    .trim();
  const parsed = sessionSummarySchema.safeParse(JSON.parse(jsonText));
  if (!parsed.success) return null;
  return parsed.data;
}

export function updateSessionPayload(db: RobinDb, eventId: number, summary: SessionSummary): void {
  db.transaction(() => {
    const row = db.prepare('SELECT payload FROM events WHERE id = ?').get(eventId) as
      | { payload: string }
      | undefined;
    if (!row) return;
    const updated = {
      ...JSON.parse(row.payload),
      summary,
      summarizedAt: new Date().toISOString(),
    };
    db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(updated), eventId);
  })();
}

/**
 * Max session.thread links created for a single new session. Bounds the
 * cross-session linking fan-out: without it, a capture sharing topics with N
 * recent sessions creates N thread rows (O(N) per capture), which exploded to
 * 1684 rows/day on 2026-06-13 when a flood of sessions shared generic topics.
 */
const MAX_THREAD_LINKS_PER_SESSION = 8;

export function linkRelatedSessions(db: RobinDb, eventId: number, topics: string[]): number {
  if (topics.length === 0) return 0;
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const recentSessions = db
    .prepare(
      `SELECT id, payload FROM events
       WHERE kind IN ('session.captured', 'conversation.claude-code')
         AND id != ? AND ts > ?
       ORDER BY ts DESC LIMIT 50`,
    )
    .all(eventId, cutoff) as Array<{ id: number; payload: string }>;

  const existingThreads = new Set(
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.from_event_id') || ':' ||
                  json_extract(payload, '$.to_event_id') AS key
           FROM events WHERE kind = 'session.thread'
             AND json_extract(payload, '$.to_event_id') = ?`,
        )
        .all(eventId) as Array<{ key: string }>
    ).map((r) => r.key),
  );

  let linked = 0;
  const topicSet = new Set(topics);
  for (const prior of recentSessions) {
    // recentSessions is ordered newest-first, so capping here keeps the most
    // recent (most relevant) links and bounds the per-capture fan-out.
    if (linked >= MAX_THREAD_LINKS_PER_SESSION) break;
    let priorTopics: string[] = [];
    try {
      priorTopics = JSON.parse(prior.payload).summary?.topics ?? [];
    } catch {
      continue;
    }
    const shared = priorTopics.filter((t) => topicSet.has(t));
    if (shared.length < 2) continue;

    const threadKey = `${prior.id}:${eventId}`;
    if (existingThreads.has(threadKey)) continue;

    db.prepare(
      `INSERT INTO events (ts, kind, source, status, payload)
       VALUES (?, 'session.thread', 'biographer', 'ok', ?)`,
    ).run(
      new Date().toISOString(),
      JSON.stringify({
        from_event_id: prior.id,
        to_event_id: eventId,
        shared_topics: shared,
      }),
    );
    linked++;
  }
  return linked;
}

export async function runBiographer(
  db: RobinDb,
  llm: LLMDispatcher | null,
  limit: number = 10,
  options: RunBiographerOptions = {},
): Promise<BiographerRunResult> {
  // Load the adaptive noise blocklist once per tick. O(1) per-entity check
  // via Set.has(), no per-entity DB query. Grows nightly as the hygiene pass
  // identifies new noise names.
  let noiseBlocklist: Set<string>;
  try {
    noiseBlocklist = loadNoiseBlocklist(db);
  } catch {
    noiseBlocklist = new Set(); // table may not exist yet (pre-migration)
  }

  const chunkTimeoutMs = options.chunkTimeoutMs ?? BIOGRAPHER_CHUNK_TIMEOUT_MS;
  const disambiguationTimeoutMs = options.disambiguationTimeoutMs ?? DISAMBIGUATION_TIMEOUT_MS;

  const maxChunksPerTick = options.maxChunksPerTick ?? MAX_CHUNKS_PER_TICK;
  const maxSessionBodyChars = options.maxSessionBodyChars ?? MAX_SESSION_BODY_CHARS;
  const minSessionBodyChars = options.minSessionBodyChars ?? MIN_SESSION_BODY_CHARS;
  const batchChunks = options.batchChunks ?? 1;
  const skipToolChunks = options.skipToolChunks ?? false;
  const draftClaims = options.draftClaims ?? false;
  const domainGating = options.domainGating ?? true;
  const tickDeadlineMs = options.tickDeadlineMs;
  const now = options.now ?? (() => Date.now());
  const tickStartedAt = now();
  const deadlineActive =
    tickDeadlineMs !== undefined && Number.isFinite(tickDeadlineMs) && tickDeadlineMs > 0;

  const result: BiographerRunResult = {
    processed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    claimsDrafted: 0,
    claimsDropped: 0,
    sessionsSummarized: 0,
    sessionsLinked: 0,
    errors: [],
  };

  // Hard cap on extraction LLM calls across this whole call, independent of
  // `limit`. This is what guarantees a bounded tick: a single huge session
  // advances at most `maxChunksPerTick` chunks before yielding, so it can never
  // hold the scheduler past the daemon's restart gate.
  let chunkBudget = maxChunksPerTick;

  for (let s = 0; s < limit; s++) {
    if (chunkBudget <= 0) break;
    // Overall tick deadline — stop claiming further sessions once the wall-clock
    // budget is spent. Graceful: per-chunk progress is already persisted, so the
    // next cron tick resumes the backlog from the cursor.
    if (deadlineActive && now() - tickStartedAt >= (tickDeadlineMs as number)) break;

    const target = selectBiographerTarget(db);
    if (!target) break;

    // Bug G — a fresh session whose body is absurdly large is skipped with a
    // marker so it stops being re-selected. Multi-tick handles ordinary large
    // sessions; this guard only catches pathological outliers. (A resumed
    // session already cleared this gate when it was first selected.)
    if (!target.isResume && target.body.length > maxSessionBodyChars) {
      db.prepare(`
        INSERT INTO events (ts, kind, source, status, payload)
        VALUES (?, 'biographer.extracted', 'biographer', 'skipped', ?)
      `).run(
        new Date().toISOString(),
        JSON.stringify({
          source_event_id: target.eventId,
          entities: 0,
          relations: 0,
          skipped: true,
          reason: 'session_too_large',
          body_chars: target.body.length,
          threshold: maxSessionBodyChars,
        }),
      );
      result.errors.push(
        `event ${target.eventId}: skipped (${target.body.length} chars > ${maxSessionBodyChars})`,
      );
      result.processed++;
      continue;
    }

    // Skip tiny sessions — too short to contain meaningful entities, and
    // processing them wastes ~80s of LLM time per session for near-zero value.
    if (!target.isResume && target.body.length < minSessionBodyChars) {
      db.prepare(`
        INSERT INTO events (ts, kind, source, status, payload)
        VALUES (?, 'biographer.extracted', 'biographer', 'skipped', ?)
      `).run(
        new Date().toISOString(),
        JSON.stringify({
          source_event_id: target.eventId,
          entities: 0,
          relations: 0,
          skipped: true,
          reason: 'session_too_small',
          body_chars: target.body.length,
          threshold: minSessionBodyChars,
        }),
      );
      result.processed++;
      continue;
    }

    // Skip sessions with no human input — purely automated/tool captures
    // (e.g. daemon-fired or hook-captured sessions with no [USER] marker).
    // Only applies to transcript-format bodies (those with role markers);
    // raw text (no markers) is always processed.
    const bodyHasRoleMarkers = /\[(USER|ASSISTANT|TOOL|SYSTEM)\]/i.test(target.body);
    if (!target.isResume && bodyHasRoleMarkers && !/\[USER\]/i.test(target.body)) {
      db.prepare(`
        INSERT INTO events (ts, kind, source, status, payload)
        VALUES (?, 'biographer.extracted', 'biographer', 'skipped', ?)
      `).run(
        new Date().toISOString(),
        JSON.stringify({
          source_event_id: target.eventId,
          entities: 0,
          relations: 0,
          skipped: true,
          reason: 'no_human_content',
          body_chars: target.body.length,
        }),
      );
      result.processed++;
      continue;
    }

    const cleanedBody = preprocessForExtraction(target.body);
    const chunks = chunkBody(cleanedBody, CHUNK_CHARS);
    const totalChunks = chunks.length;
    const startChunk = target.nextChunk;
    const mergedEntities = target.entities;
    const mergedRelations = target.relations;
    // Set when the claims pass hits a hard LLM outage: this target still
    // finalizes (its entity work is real), but the tick stops after it.
    let claimsOutage = false;

    // Extract this tick's slice of chunks. With no LLM there is nothing to
    // extract, so the session finalizes immediately with an empty result
    // (preserves the historical no-LLM marker behavior).
    let endChunk = totalChunks;
    if (llm) {
      endChunk = Math.min(startChunk + chunkBudget, totalChunks);
      let successes = 0;
      let llmUnavailable = false;

      // Levers 2+3: skip tool-only chunks (no [USER] marker = pure tool output
      // with no user-initiated entities) and batch adjacent content chunks to
      // amortize the per-invoke thinking overhead (~60s) across multiple chunks.
      for (let ci = startChunk; ci < endChunk; ) {
        // Collect the next batch of non-tool chunks. A chunk is "tool-only"
        // (skippable) if it's a transcript-format chunk (has [TOOL]/[ASSISTANT]
        // markers) but lacks [USER] input. Raw text (no markers) is always
        // processed — the filter only applies to Claude Code transcripts.
        const batch: number[] = [];
        while (batch.length < batchChunks && ci < endChunk) {
          const c = chunks[ci];
          if (skipToolChunks) {
            const cLower = c.toLowerCase();
            const hasRoleMarkers = cLower.includes('[tool]') || cLower.includes('[assistant]');
            const isToolOnly = hasRoleMarkers && !cLower.includes('[user]');
            if (!isToolOnly) batch.push(ci);
          } else {
            batch.push(ci);
          }
          ci++;
        }
        if (batch.length === 0) continue;

        const batchText =
          batch.length === 1 ? chunks[batch[0]] : batch.map((i) => chunks[i]).join('\n---\n');

        try {
          const inv = await withTimeout(
            llm.invoke('reasoning', {
              systemPrompt: SYSTEM_PROMPT,
              messages: [{ role: 'user', content: batchText }],
              temperature: 0,
              maxTokens: 4096,
            }),
            chunkTimeoutMs * batch.length,
            `biographer event=${target.eventId} chunks=${batch.join(',')}/${totalChunks}`,
          );
          const jsonText = inv.text
            .trim()
            .replace(/^```(?:json)?/, '')
            .replace(/```$/, '')
            .trim();
          const parsed = JSON.parse(jsonText);
          const validated = extractionSchema.safeParse(parsed);
          if (!validated.success) {
            result.errors.push(
              `event ${target.eventId} batch [${batch}]: schema mismatch — ${validated.error.issues.map((i) => i.message).join('; ')}`,
            );
            continue;
          }
          successes += batch.length;
          for (const e of validated.data.entities) {
            const key = entityKey(e);
            if (!mergedEntities.has(key)) mergedEntities.set(key, e);
          }
          for (const r of validated.data.relations) {
            const key = relationKey(r);
            if (!mergedRelations.has(key)) mergedRelations.set(key, r);
          }
        } catch (err) {
          if (isHardLlmOutage(err)) {
            // Hard outage: park the session exactly at the failed batch and
            // abort the whole tick. Finalizing now would write an empty
            // extraction and advance past content the LLM never saw; the next
            // tick resumes from this cursor once the limit window resets.
            saveBiographerProgress(
              db,
              target.eventId,
              totalChunks,
              batch[0],
              mergedEntities,
              mergedRelations,
            );
            result.errors.push(
              `event ${target.eventId} batch [${batch}]: ${err instanceof Error ? err.message : String(err)} — hard LLM outage, tick aborted with cursor parked`,
            );
            return result;
          }
          if (isLlmUnavailableError(err)) llmUnavailable = true;
          result.errors.push(
            `event ${target.eventId} batch [${batch}]: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // When all chunks in a session timed out, log it but DO NOT break — let the
      // cursor advance past the failed chunks and finalize the session with whatever
      // succeeded (possibly 0 entities). The per-chunk timeout (2 min) is the safety
      // net. The old circuit-breaker used `break` here, which caused a permanent stall:
      // one session whose content hung the model would be re-selected every tick,
      // timeout, break, re-select — blocking the entire pipeline forever.
      if (llmUnavailable && successes === 0) {
        result.errors.push(
          `event ${target.eventId}: all chunks timed out — advancing cursor past them`,
        );
      }
      chunkBudget -= endChunk - startChunk;

      // ─── Second pass: claim drafting ───────────────────────────────────────
      // Fully separate from the entity/relation flow above. Runs only on this
      // tick's chunks that contain [USER] content, each individually timeout-
      // bounded, against its OWN small budget so it can never blow the tick.
      // Drafts land as pending belief_candidates (never the truth stream). The
      // per-session cap counts already-queued pending candidates for this source
      // so it holds across ticks without extra state.
      if (draftClaims) {
        let claimsBudget = maxChunksPerTick;
        let sessionPending = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM belief_candidates
                WHERE status = 'pending' AND source_event_id = ?`,
            )
            .get(target.eventId) as { c: number }
        ).c;

        // Compute provenance class once per target event — fetch the source
        // event's kind and classify it so every candidate from this session
        // carries the correct class tag. Done here (not per-claim) to avoid
        // N redundant DB reads for a session that may produce many claims.
        const sourceEventRow = db
          .prepare(`SELECT kind FROM events WHERE id = ?`)
          .get(target.eventId) as { kind: string } | undefined;
        const targetProvenance = classifyProvenance(sourceEventRow ? [sourceEventRow.kind] : []);

        // Knowledge docs (from ingestContentDocs) are plain markdown without
        // transcript role markers — they are inherently user-authored content.
        // Only require the [USER] marker for transcript-format bodies.
        const bodyIsTranscript = /\[(USER|ASSISTANT|TOOL|SYSTEM)\]/i.test(cleanedBody);

        for (let ci = startChunk; ci < endChunk && claimsBudget > 0; ci++) {
          if (sessionPending >= MAX_CLAIMS_PER_SESSION) break;
          const chunk = chunks[ci];
          // Only chunks with user-authored content can carry durable user facts.
          // For transcripts, require a [USER] marker; for knowledge docs (plain
          // markdown), all content is user-authored.
          if (bodyIsTranscript && !/\[USER\]/i.test(chunk)) continue;
          claimsBudget--;
          try {
            const { claims, failure } = await extractClaims(
              llm,
              chunk,
              chunkTimeoutMs,
              `biographer-claims event=${target.eventId} chunk=${ci}/${totalChunks}`,
            );
            if (failure) {
              // Parse/schema failure: the model responded with untrusted output.
              // Dead-letter the chunk so the retry pass can re-attempt it, then
              // keep surfacing the error the way the loop always has.
              try {
                recordClaimFailure(db, target.eventId, ci, chunk, failure);
              } catch {
                // best-effort — a dead-letter write failure must not break the loop
              }
              result.errors.push(`event ${target.eventId} claims chunk ${ci}: ${failure}`);
            }
            for (const c of claims) {
              if (sessionPending >= MAX_CLAIMS_PER_SESSION) break;
              if (!c.topic?.trim() || !c.claim?.trim()) continue;
              // Allowlist gate (Phase D): only personal-domain claims enter the
              // queue. An untagged or non-personal claim is engineering/transient
              // noise — drop it. The deterministic isLowQualityClaim backstop
              // inside insertCandidateWithDedup still runs on what passes.
              if (domainGating && !isPersonalDomain(c.domain)) {
                result.claimsDropped++;
                continue;
              }
              const inserted = await insertCandidateWithDedup(db, llm, {
                topic: c.topic,
                claim: c.claim,
                confidence: c.confidence ?? null,
                sourceEventId: target.eventId,
                provenance: targetProvenance,
                domain: c.domain ?? null,
              });
              // id === -1 → filtered as a dev/engineering artifact; don't count it.
              if (inserted.id === -1) continue;
              // merged → folded into an existing candidate (corroboration), no new
              // queue row; don't count it as a fresh draft or against the budget.
              if (inserted.merged) continue;
              sessionPending++;
              result.claimsDrafted++;
            }
          } catch (err) {
            // A failed claims chunk never blocks the session — entity/relation
            // extraction already advanced the cursor; claims are best-effort.
            // Timeouts (withTimeout → TimeoutError) and any other invoke throw land
            // here; dead-letter the chunk verbatim so the retry pass can re-run it.
            const msg = err instanceof Error ? err.message : String(err);
            try {
              recordClaimFailure(db, target.eventId, ci, chunk, msg);
            } catch {
              // best-effort — a dead-letter write failure must not break the loop
            }
            result.errors.push(`event ${target.eventId} claims chunk ${ci}: ${msg}`);
            if (isHardLlmOutage(err)) {
              // Hard outage mid-claims: the entity pass above already succeeded,
              // so the session WILL finalize and its cursor advance — any chunk
              // not dead-lettered here would lose its claims forever. Preserve
              // every remaining eligible chunk without LLM spend, then stop the
              // tick after this target finalizes.
              for (let rest = ci + 1; rest < endChunk; rest++) {
                const restChunk = chunks[rest];
                if (bodyIsTranscript && !/\[USER\]/i.test(restChunk)) continue;
                try {
                  recordClaimFailure(db, target.eventId, rest, restChunk, msg);
                } catch {
                  // best-effort — a dead-letter write failure must not break the loop
                }
              }
              claimsOutage = true;
              break;
            }
          }
        }
      }
    }

    // Not finished — persist progress and yield. The next tick resumes from
    // `endChunk` with the merged entities/relations restored from the row.
    if (endChunk < totalChunks) {
      saveBiographerProgress(
        db,
        target.eventId,
        totalChunks,
        endChunk,
        mergedEntities,
        mergedRelations,
      );
      continue;
    }

    // All chunks extracted → filter, disambiguate, upsert, mark done.
    let extracted: ExtractionResult = {
      entities: [...mergedEntities.values()],
      relations: [...mergedRelations.values()],
    };

    // Post-extraction quality filter. Drop entities that match the stop-word
    // patterns (role markers, bare numbers, SHAs, state flags), then drop any
    // relation whose subject or object pointed at a dropped entity. Done
    // BEFORE disambiguation so we don't burn LLM calls on garbage.
    const droppedNames = new Set<string>();
    const filteredEntities = [];
    for (const e of extracted.entities) {
      if (isLowQualityEntity(e.name, e.type) || noiseBlocklist.has(e.name.toLowerCase())) {
        droppedNames.add(e.name.toLowerCase());
        continue;
      }
      filteredEntities.push(e);
    }
    const filteredRelations = extracted.relations.filter(
      (r) =>
        !isLowQualityPredicate(r.predicate) &&
        !droppedNames.has(r.subject.toLowerCase()) &&
        !droppedNames.has(r.object.toLowerCase()) &&
        !isLowQualityEntity(r.subject) &&
        !isLowQualityEntity(r.object),
    );
    extracted = { entities: filteredEntities, relations: filteredRelations };

    // Batch-extraction guard: if a single type has >20 entities from one event,
    // it's likely a list dump (e.g. Spotify playlist, bookmarks, transaction log).
    // Drop the flooded type — it's bulk data noise, not biographical entities.
    const typeCounts = new Map<string, number>();
    for (const e of extracted.entities) {
      typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    }
    const floodedTypes = new Set<string>();
    for (const [t, count] of typeCounts) {
      if (count > 20) floodedTypes.add(t);
    }
    if (floodedTypes.size > 0) {
      const floodedNames = new Set<string>();
      extracted.entities = extracted.entities.filter((e) => {
        if (floodedTypes.has(e.type)) {
          floodedNames.add(e.name.toLowerCase());
          return false;
        }
        return true;
      });
      extracted.relations = extracted.relations.filter(
        (r) =>
          !floodedNames.has(r.subject.toLowerCase()) && !floodedNames.has(r.object.toLowerCase()),
      );
    }

    // Upsert entities with LLM-driven disambiguation
    const idByName = new Map<string, number>();
    for (const e of extracted.entities) {
      try {
        const { matchedId } = await disambiguateEntity(
          db,
          llm,
          { type: e.type, name: e.name, sourceText: target.body },
          disambiguationTimeoutMs,
        );
        if (matchedId !== null) {
          idByName.set(e.name, matchedId);
        } else {
          const ent = upsertEntity(db, e.type, e.name);
          idByName.set(e.name, ent.id);
          result.entitiesCreated++;
        }
      } catch (err) {
        result.errors.push(`entity ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Add relations (with predicate normalization + directionality dedup)
    for (const r of extracted.relations) {
      const sId = idByName.get(r.subject) ?? upsertEntity(db, 'thing', r.subject).id;
      const oId = idByName.get(r.object) ?? upsertEntity(db, 'thing', r.object).id;
      const pred = normalizePredicate(r.predicate);
      addRelation(db, sId, pred, oId, target.eventId);
      result.relationsCreated++;
    }

    // ─── Session finalization (best-effort, never blocks extraction) ────────
    const sourceKind = db.prepare('SELECT kind, ts FROM events WHERE id = ?').get(target.eventId) as
      | { kind: string; ts: string }
      | undefined;
    const isSession =
      sourceKind?.kind === 'session.captured' || sourceKind?.kind === 'conversation.claude-code';

    if (llm && isSession && chunks.length > 0) {
      try {
        const targetWithTs = { ...target, ts: sourceKind?.ts };
        const summary = await finalizeSession(llm, targetWithTs, chunks, extracted, chunkTimeoutMs);
        if (summary) {
          updateSessionPayload(db, target.eventId, summary);
          result.sessionsSummarized++;
          result.sessionsLinked += linkRelatedSessions(db, target.eventId, summary.topics);
        }
      } catch (err) {
        result.errors.push(
          `event ${target.eventId} finalization: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    writeExtractedMarker(db, target.eventId, extracted.entities.length, extracted.relations.length);
    if (target.isResume) {
      db.prepare(`DELETE FROM biographer_progress WHERE source_event_id = ?`).run(target.eventId);
    }
    result.processed++;
    // A hard outage during claims means every further target would burn calls
    // against a downed LLM — stop the tick here; the next one resumes cleanly.
    if (claimsOutage) return result;
  }

  return result;
}

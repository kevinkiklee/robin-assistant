import { z } from 'zod';
import { TimeoutError, withTimeout } from '../../lib/with-timeout.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { insertBeliefCandidate } from '../memory/belief-candidate.ts';
import type { RobinDb } from '../memory/db.ts';
import { addRelation, findEntity, upsertEntity } from '../memory/entity.ts';

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
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|network|failed to connect|connection refused|terminated|fetch is not defined/i.test(
    msg,
  );
}

// Bug E mitigation — bound any single chunk's LLM call so one stuck chunk can't
// block the scheduler forever. With maxTokens=4096 on the invoke, generation is
// bounded to ~77s at 53 tok/s regardless of thinking length — so 2 min is
// generous (catches genuine hangs without flagging real work). Combined with
// MAX_CHUNKS_PER_TICK=10 → worst-case tick = 10 × 2 = 20 min (under the
// 30-min heartbeat gate).
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

const claimsSchema = z.object({
  claims: z
    .array(
      z.object({
        topic: z.string(),
        claim: z.string(),
        confidence: z.number().nullable().optional(),
      }),
    )
    .default([]),
});

export type ClaimsResult = z.infer<typeof claimsSchema>;

const CLAIMS_SYSTEM_PROMPT = `You extract DURABLE FACTS about the user (and their world) from a transcript. Reply ONLY with JSON matching:
{"claims":[{"topic":"<short-kebab-topic>","claim":"<one declarative sentence>","confidence":<0..1>}, ...]}

A claim is a stable, declarative fact that would still be true in a future session — e.g. "kevin's google role is ad experiences", "kevin lives in bergen county nj", "kevin's main camera is a nikon z8".

Do NOT emit:
- Imperatives or behavior rules ("never pitch X", "always do Y") — those are not claims.
- Transient session details (what was debugged today, a command that was run, a file that was edited).
- Speculation, questions, or anything you are not reasonably confident is a durable fact.
- Facts about the assistant itself rather than the user.

topic: a short kebab-case key for the fact (e.g. "google-role", "home-location", "primary-camera").
confidence: your confidence 0..1 that this is a durable, correct fact.
If nothing durable is present, reply {"claims":[]}.`;

// Hard cap on candidate claims drafted per session — keeps a chatty model from
// flooding the review queue from a single transcript.
const MAX_CLAIMS_PER_SESSION = 20;

/**
 * Run the claim-drafting pass on a single chunk. Returns the validated claims
 * (possibly empty). Individually timeout-bounded by the caller's chunk timeout
 * and capped at a small maxTokens so it can never blow the tick. Tolerant of
 * fenced/invalid output — a bad chunk yields zero claims rather than throwing.
 */
export async function extractClaims(
  llm: LLMDispatcher,
  chunkText: string,
  timeoutMs: number,
  label: string,
): Promise<ClaimsResult['claims']> {
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
  const parsed = claimsSchema.safeParse(JSON.parse(jsonText));
  if (!parsed.success) return [];
  return parsed.data.claims;
}

/**
 * Clean a captured session body before LLM extraction. Strips noise that wastes
 * model time, inflates chunk counts, and can trigger model hangs:
 * - [TOOL] blocks (file reads, bash output, JSON blobs — zero entities)
 * - Code blocks (triple-backtick fences — rarely contain entities)
 * - Consecutive [ASSISTANT] turns collapsed into one (prevents many-turn degeneracy)
 * - Very short turns (<50 chars — "Done.", "Starting." — no entity content)
 */
export function preprocessForExtraction(body: string): string {
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
}

type EntityRecord = { type: string; name: string };
type RelationRecord = { subject: string; predicate: string; object: string };

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
    for (const e of JSON.parse(resume.entitiesJson) as EntityRecord[])
      entities.set(entityKey(e), e);
    const relations = new Map<string, RelationRecord>();
    for (const r of JSON.parse(resume.relationsJson) as RelationRecord[])
      relations.set(relationKey(r), r);
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
       WHERE events.kind = 'session.captured'
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

const SYSTEM_PROMPT = `You extract structured entities and relations from a transcript. Reply ONLY with JSON matching:
{"entities":[{"type":"<type>","name":"..."}, ...], "relations":[{"subject":"name","predicate":"verb","object":"name"}, ...]}

Valid <type> values: person, place, organization, service, library, tool, repository, env_var, error, topic, thing.
Prefer the most specific type that fits; use "thing" only when nothing more specific applies.

Do NOT extract:
- Transcript role markers (USER, ASSISTANT, TOOL, SYSTEM) — they are not real entities.
- Bare numbers, state flags (ON, OFF, TRUE, FALSE, ENABLED, DISABLED), or git SHA fragments.
- Single-character or empty names.

If nothing is worth extracting, reply {"entities":[],"relations":[]}.`;

/**
 * Defensive filter applied AFTER LLM extraction to drop noise that the model
 * sometimes emits despite the prompt rules above. The prompt is a soft contract;
 * this is the hard one. Returning true means "drop this entity".
 *
 * Companion: any relation whose subject or object matches a dropped entity is
 * also dropped (a relation pointing at noise is itself noise).
 */
export function isLowQualityEntity(name: string): boolean {
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
  return false;
}

const ROLE_MARKER_NAMES = new Set(['user', 'assistant', 'tool', 'system', 'human', 'ai']);
// Generic nouns + Claude Code tool names that get mis-extracted as entities.
const GENERIC_NOISE_NAMES = new Set([
  // generic programming/content nouns
  'file', 'files', 'code', 'function', 'functions', 'value', 'values', 'data',
  'error', 'errors', 'test', 'tests', 'result', 'results', 'output', 'input',
  'text', 'line', 'lines', 'table', 'tables', 'list', 'lists', 'item', 'items',
  'step', 'steps', 'note', 'notes', 'todo', 'todos', 'example', 'examples',
  'content', 'config', 'json', 'thing', 'things', 'stuff', 'object', 'objects',
  'field', 'fields', 'row', 'rows', 'column', 'columns', 'string', 'strings',
  // Claude Code tool names
  'read', 'edit', 'write', 'bash', 'grep', 'glob', 'task', 'ls', 'multiedit',
  'todowrite', 'webfetch', 'websearch', 'notebookedit',
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

export async function runBiographer(
  db: RobinDb,
  llm: LLMDispatcher | null,
  limit: number = 10,
  options: RunBiographerOptions = {},
): Promise<BiographerRunResult> {
  const chunkTimeoutMs = options.chunkTimeoutMs ?? BIOGRAPHER_CHUNK_TIMEOUT_MS;
  const disambiguationTimeoutMs = options.disambiguationTimeoutMs ?? DISAMBIGUATION_TIMEOUT_MS;

  const maxChunksPerTick = options.maxChunksPerTick ?? MAX_CHUNKS_PER_TICK;
  const maxSessionBodyChars = options.maxSessionBodyChars ?? MAX_SESSION_BODY_CHARS;
  const minSessionBodyChars = options.minSessionBodyChars ?? MIN_SESSION_BODY_CHARS;
  const batchChunks = options.batchChunks ?? 1;
  const skipToolChunks = options.skipToolChunks ?? false;
  const draftClaims = options.draftClaims ?? false;

  const result: BiographerRunResult = {
    processed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    claimsDrafted: 0,
    errors: [],
  };

  // Hard cap on extraction LLM calls across this whole call, independent of
  // `limit`. This is what guarantees a bounded tick: a single huge session
  // advances at most `maxChunksPerTick` chunks before yielding, so it can never
  // hold the scheduler past the daemon's restart gate.
  let chunkBudget = maxChunksPerTick;

  for (let s = 0; s < limit; s++) {
    if (chunkBudget <= 0) break;

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
        for (let ci = startChunk; ci < endChunk && claimsBudget > 0; ci++) {
          if (sessionPending >= MAX_CLAIMS_PER_SESSION) break;
          const chunk = chunks[ci];
          // Only chunks with user-authored content can carry durable user facts.
          if (!/\[USER\]/i.test(chunk)) continue;
          claimsBudget--;
          try {
            const claims = await extractClaims(
              llm,
              chunk,
              chunkTimeoutMs,
              `biographer-claims event=${target.eventId} chunk=${ci}/${totalChunks}`,
            );
            for (const c of claims) {
              if (sessionPending >= MAX_CLAIMS_PER_SESSION) break;
              if (!c.topic?.trim() || !c.claim?.trim()) continue;
              insertBeliefCandidate(db, {
                topic: c.topic,
                claim: c.claim,
                confidence: c.confidence ?? null,
                sourceEventId: target.eventId,
              });
              sessionPending++;
              result.claimsDrafted++;
            }
          } catch (err) {
            // A failed claims chunk never blocks the session — entity/relation
            // extraction already advanced the cursor; claims are best-effort.
            result.errors.push(
              `event ${target.eventId} claims chunk ${ci}: ${err instanceof Error ? err.message : String(err)}`,
            );
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
      if (isLowQualityEntity(e.name)) {
        droppedNames.add(e.name.toLowerCase());
        continue;
      }
      filteredEntities.push(e);
    }
    const filteredRelations = extracted.relations.filter(
      (r) =>
        !droppedNames.has(r.subject.toLowerCase()) &&
        !droppedNames.has(r.object.toLowerCase()) &&
        !isLowQualityEntity(r.subject) &&
        !isLowQualityEntity(r.object),
    );
    extracted = { entities: filteredEntities, relations: filteredRelations };

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
    // Add relations
    for (const r of extracted.relations) {
      const sId = idByName.get(r.subject) ?? upsertEntity(db, 'thing', r.subject).id;
      const oId = idByName.get(r.object) ?? upsertEntity(db, 'thing', r.object).id;
      addRelation(db, sId, r.predicate, oId, target.eventId);
      result.relationsCreated++;
    }

    writeExtractedMarker(db, target.eventId, extracted.entities.length, extracted.relations.length);
    if (target.isResume) {
      db.prepare(`DELETE FROM biographer_progress WHERE source_event_id = ?`).run(target.eventId);
    }
    result.processed++;
  }

  return result;
}

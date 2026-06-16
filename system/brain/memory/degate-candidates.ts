import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { isLowQualityClaim } from './belief-quality.ts';
import type { RobinDb } from './db.ts';
import { isPersonalDomain, PERSONAL_DOMAINS } from './domains.ts';
import { ingest } from './ingest.ts';

/**
 * Render a Date in SQLite's `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`,
 * UTC) so string comparisons against the `resolved_at` column — which defaults
 * to `datetime('now')` — are apples-to-apples (an ISO `T…Z` string sorts
 * inconsistently against the space-separated SQLite form).
 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export interface DegateResult {
  scanned: number;
  culled: number;
  keptDeterministic: number;
  llmClassified: number;
  samples: Array<{ id: number; topic: string; claim: string; reason: string }>;
}

const LLM_BATCH = 25;

/**
 * Classify a batch of candidates by domain using the LLM. Returns a Map from
 * row id → domain string. On ANY parse or invocation failure the whole batch
 * is treated as KEPT (never cull on uncertainty — recall bias). Strips code
 * fences before JSON.parse.
 */
async function classifyDomains(
  llm: LLMDispatcher,
  batch: Array<{ id: number; topic: string; claim: string }>,
): Promise<Map<number, string>> {
  const systemPrompt = [
    'You are a domain classifier for a personal memory assistant.',
    `Classify each item as exactly one of: ${[...PERSONAL_DOMAINS, 'engineering'].join(', ')}.`,
    '"engineering" covers: code, tools, configs, Robin internals, project infrastructure, MCP servers, packages, repos, deployments, CLI tools, integrations, or any software development artifact.',
    'Reply ONLY with a JSON array, no explanation, no markdown fences.',
    'Format: [{"id":<number>,"domain":"<one of the listed values>"}]',
  ].join(' ');

  const userContent = batch
    .map((r, i) => `${i + 1}. id=${r.id}: "${r.topic} — ${r.claim}"`)
    .join('\n');

  let text: string;
  try {
    const result = await llm.invoke('reasoning', {
      systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: 512,
    });
    text = result.text;
  } catch {
    // LLM failure → keep everything in this batch (recall bias).
    return new Map();
  }

  // Strip code fences if present.
  const stripped = text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Array<{ id: number; domain: string }>;
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<number, string>();
    for (const entry of parsed) {
      if (typeof entry.id === 'number' && typeof entry.domain === 'string') {
        out.set(entry.id, entry.domain);
      }
    }
    return out;
  } catch {
    // Parse failure → keep everything (recall bias).
    return new Map();
  }
}

/**
 * Retroactive cleanup (Phase D, Component 4): cull pending belief candidates
 * that are dev/engineering artifacts, NOT facts about Kevin's life. Mirrors
 * the canonicalize sweep — dry-run by default, reversible reject
 * (`status='rejected'`, `resolved_reason='degate-engineering'`), a
 * `memory.degate` audit event on apply, idempotent (acts only on
 * `status='pending'`).
 *
 * Two passes:
 *   1. DETERMINISTIC (always on, free): `isLowQualityClaim` catches known
 *      dev artifacts. Culled with reason `'dev-artifact'`.
 *   2. OPTIONAL LLM (`opts.useLlm` + `llm` present): batches the remainder
 *      (≤25/call) through `classifyDomains`; anything NOT in PERSONAL_DOMAINS
 *      is culled with reason `'llm:<label>'`. On parse/LLM failure the whole
 *      batch is KEPT — never cull on uncertainty.
 *
 * `opts.apply` must be true for any writes to happen; dry-run (default) makes
 * no DB changes. `opts.max` bounds how many pending rows are considered per
 * run (default 10 000). Idempotent: a second run finds nothing new to cull
 * because the first pass consumed all `status='pending'` rows.
 */
export async function degateCandidates(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { apply?: boolean; useLlm?: boolean; max?: number } = {},
): Promise<DegateResult> {
  const max = opts.max ?? 10_000;
  const rows = db
    .prepare(
      `SELECT id, topic, claim FROM belief_candidates
        WHERE status = 'pending' AND domain IS NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .all(max) as Array<{ id: number; topic: string; claim: string }>;

  const result: DegateResult = {
    scanned: rows.length,
    culled: 0,
    keptDeterministic: 0,
    llmClassified: 0,
    samples: [],
  };

  const cull = (id: number, topic: string, claim: string, reason: string): void => {
    if (opts.apply) {
      db.prepare(
        `UPDATE belief_candidates
            SET status = 'rejected', resolved_at = ?, resolved_reason = 'degate-engineering'
          WHERE id = ? AND status = 'pending'`,
      ).run(sqliteUtc(new Date()), id);
    }
    result.culled++;
    if (result.samples.length < 25) result.samples.push({ id, topic, claim, reason });
  };

  // Pass 1: deterministic, free, always on.
  const remainder: Array<{ id: number; topic: string; claim: string }> = [];
  for (const r of rows) {
    if (isLowQualityClaim(r.topic, r.claim)) {
      cull(r.id, r.topic, r.claim, 'dev-artifact');
    } else {
      remainder.push(r);
    }
  }

  // Pass 2: optional batched LLM domain classification of the remainder.
  if (opts.useLlm && llm && remainder.length > 0) {
    for (let i = 0; i < remainder.length; i += LLM_BATCH) {
      const batch = remainder.slice(i, i + LLM_BATCH);
      const classified = await classifyDomains(llm, batch);
      // An empty Map signals a parse/invocation failure (classifyDomains contract:
      // return empty map on any failure → callers keep everything — recall bias).
      // A partially-filled map is also treated conservatively: only cull an item
      // if its id is PRESENT in the map with a non-personal domain; absent ids
      // (unclassified by a partial result) are kept.
      for (const r of batch) {
        result.llmClassified++;
        if (!classified.has(r.id)) {
          // Not classified (failure or partial) → keep (recall bias).
          result.keptDeterministic++;
          continue;
        }
        const domain = classified.get(r.id);
        if (!isPersonalDomain(domain)) {
          cull(r.id, r.topic, r.claim, `llm:${domain ?? 'engineering'}`);
        } else {
          result.keptDeterministic++;
        }
      }
    }
  } else {
    result.keptDeterministic += remainder.length;
  }

  // Audit event — only when applying AND at least one row was culled.
  if (opts.apply && result.culled > 0) {
    ingest(db, llm, {
      kind: 'memory.degate',
      source: 'maintenance',
      content: `degate: culled ${result.culled}/${result.scanned} pending candidates (llm=${!!opts.useLlm})`,
      payload: {
        scanned: result.scanned,
        culled: result.culled,
        keptDeterministic: result.keptDeterministic,
        llmClassified: result.llmClassified,
        external_id: `degate:${new Date().toISOString().slice(0, 10)}`,
      },
    });
  }

  return result;
}

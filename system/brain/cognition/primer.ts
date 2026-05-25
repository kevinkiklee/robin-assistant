import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { recallBelief } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';
import {
  ageDaysFrom,
  effectiveConfidence,
  isStale,
  SUSPECT_CONFIDENCE_THRESHOLD,
  WEAK_PROVENANCE,
} from '../memory/provenance.ts';

/**
 * The session-start primer is a derived, materialized view — never authoritative. It
 * assembles the rich-narrative layer Robin should "remember" at the top of every Claude
 * Code session, drawn entirely from already-stored data:
 *
 *   1. active corrections (behavioral rules)        — corrections table
 *   2. belief heads (supersedable declarative facts) — recallBelief(db)
 *   3. character.md + voice.md inline                — content/profile/
 *   4. an index of the other profile/knowledge docs  — file titles only
 *   5. "N candidate beliefs pending review."         — belief_candidates (defensive)
 *
 * NO LLM CALL: just a handful of SQL queries plus two small file reads, so it runs in
 * single-digit milliseconds and can sit on the session-start hot path. The output is
 * hard-capped at `maxChars`; lowest-priority sections are dropped first to fit.
 */

/** ~10,000 chars ≈ 2,500 tokens — the session-start context budget. */
const DEFAULT_MAX_CHARS = 10_000;
/**
 * Corrections get their own sub-cap so they can't crowd out everything else. Sized to
 * comfortably hold the current behavioral-rule set (~16 short directives) with headroom,
 * while still bounding unbounded future growth — overflow falls back to recall-on-demand.
 */
const CORRECTIONS_SUBCAP = 5_000;

export interface BuildPrimerOptions {
  maxChars?: number;
  profileDir?: string;
  knowledgeDir?: string;
}

interface CorrectionRow {
  what: string;
  correction: string;
  context: string | null;
}

function renderCorrections(db: RobinDb, subCap: number): string {
  let rows: CorrectionRow[];
  try {
    rows = db
      .prepare(`SELECT what, correction, context FROM corrections ORDER BY ts DESC`)
      .all() as CorrectionRow[];
  } catch {
    return '';
  }
  if (rows.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const ctx = r.context?.trim() ? ` (${r.context.trim()})` : '';
    // Render the corrective DIRECTIVE only — that's what changes behavior. Dropping the
    // verbose "what Robin said wrong → " prefix roughly halves per-line length so the full
    // current rule set fits without the oldest (often most important) rules getting dropped.
    const line = `- ${r.correction.trim()}${ctx}`;
    // Stop once adding this line would exceed the sub-cap; overflow falls back to
    // recall-on-demand (the table is still fully queryable mid-session).
    if (used + line.length + 1 > subCap) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `## Corrections (behavioral rules)\n${lines.join('\n')}`;
}

function renderBeliefs(db: RobinDb): string {
  let heads: ReturnType<typeof recallBelief>;
  try {
    heads = recallBelief(db);
  } catch {
    return '';
  }
  if (!Array.isArray(heads) || heads.length === 0) return '';
  const lines = heads
    .filter((b) => !b.retracted && b.claim.trim())
    .map((b) => {
      const base = `- ${b.topic}: ${b.claim.trim()}`;
      try {
        const age = ageDaysFrom(b.verifiedAt ?? b.ts);
        const eff = effectiveConfidence(b.confidence, age, b.provenance);
        const stale = isStale(age, b.provenance);
        const suspect =
          (eff !== null && eff < SUSPECT_CONFIDENCE_THRESHOLD) ||
          stale ||
          WEAK_PROVENANCE.has(b.provenance);
        if (!suspect) return base;
        // Build terse tag: confidence (if non-null), provenance, age, stale marker
        const parts: string[] = [];
        if (eff !== null) parts.push(eff.toFixed(1));
        parts.push(b.provenance);
        parts.push(`${Math.round(age)}d`);
        if (stale) parts.push('stale');
        return `${base} ⟨${parts.join(' · ')}⟩`;
      } catch {
        // provenance logic must never throw and break the hot path
        return base;
      }
    });
  if (lines.length === 0) return '';
  return `## Beliefs (current truth)\n${lines.join('\n')}`;
}

function readInlineDoc(dir: string, file: string): string | null {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, 'utf8').trim();
    return body ? body : null;
  } catch {
    return null;
  }
}

function renderProfileInline(profileDir: string): string {
  const sections: string[] = [];
  const character = readInlineDoc(profileDir, 'character.md');
  if (character) sections.push(`## character.md\n${character}`);
  const voice = readInlineDoc(profileDir, 'voice.md');
  if (voice) sections.push(`## voice.md\n${voice}`);
  return sections.join('\n\n');
}

/** First markdown heading (`# ...`) or, failing that, the first non-empty line. */
function firstLineHook(path: string): string {
  try {
    const body = readFileSync(path, 'utf8');
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      return line.replace(/^#+\s*/, '');
    }
  } catch {
    /* unreadable — fall through */
  }
  return '';
}

function indexDir(dir: string, exclude: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    if (exclude.has(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const hook = firstLineHook(path);
    entries.push(hook ? `- ${name} — ${hook}` : `- ${name}`);
  }
  return entries;
}

function renderIndex(profileDir: string, knowledgeDir: string): string {
  // character.md + voice.md are already inlined, so exclude them from the index.
  const profileEntries = indexDir(profileDir, new Set(['character.md', 'voice.md']));
  const knowledgeEntries = indexDir(knowledgeDir, new Set());
  const all = [...profileEntries, ...knowledgeEntries];
  if (all.length === 0) return '';
  return `## Other docs (recall on demand)\n${all.join('\n')}`;
}

function pendingCandidateCount(db: RobinDb): number {
  // Defensive: belief_candidates is created by a parallel agent's migration and may not
  // exist yet. Never import a belief-candidate module — just probe the table directly and
  // swallow the "no such table" error.
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM belief_candidates WHERE status='pending'`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function renderCandidates(db: RobinDb): string {
  const n = pendingCandidateCount(db);
  if (n <= 0) return '';
  return `${n} candidate belief${n === 1 ? '' : 's'} pending review.`;
}

/**
 * Assemble the markdown primer from stored data, hard-capped at `opts.maxChars`. Sections
 * are appended in priority order; once the running total would exceed the cap, no further
 * sections are added (lowest-priority sections drop off first). Missing tables, a missing
 * profile dir, or unreadable files degrade gracefully to omitted sections.
 */
export function buildPrimer(db: RobinDb, opts: BuildPrimerOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const userData = resolveUserDataDir();
  const profileDir = opts.profileDir ?? join(userData, 'content', 'profile');
  const knowledgeDir = opts.knowledgeDir ?? join(userData, 'content', 'knowledge');

  // Highest → lowest priority. Empty sections are skipped entirely.
  const sections = [
    renderCorrections(db, CORRECTIONS_SUBCAP),
    renderBeliefs(db),
    renderProfileInline(profileDir),
    renderIndex(profileDir, knowledgeDir),
    renderCandidates(db),
  ].filter((s) => s.length > 0);

  const out: string[] = [];
  let used = 0;
  for (const section of sections) {
    // +2 accounts for the "\n\n" joiner between sections.
    const add = (out.length === 0 ? 0 : 2) + section.length;
    if (used + add > maxChars) break;
    out.push(section);
    used += add;
  }
  return out.join('\n\n');
}

/**
 * Materialize the primer to a file (default `<userDataDir>/state/primer.md`). This is a
 * debug/inspection convenience only — the session-start path builds the primer on demand
 * via the daemon, never reading this file.
 */
export function writePrimerFile(
  db: RobinDb,
  opts: BuildPrimerOptions & { path?: string } = {},
): { path: string; bytes: number } {
  const path = opts.path ?? join(resolveUserDataDir(), 'state', 'primer.md');
  const body = buildPrimer(db, opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { path, bytes: Buffer.byteLength(body) };
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface TopicRule {
  id: string;
  match: string[];
  docs: string[];
}

/**
 * Soft size budget for a mapped canonical doc. Docs are injected WHOLE on every
 * matching turn (never truncated), so an oversized one taxes every prompt's token
 * budget. The doctor invariant warns past this so it gets curated — it does NOT
 * cap injection. ~16k chars ≈ 4k tokens: comfortably above Kevin's largest real
 * doc (health-snapshot ~13.8k) yet low enough to flag genuine bloat.
 */
export const DOC_SIZE_WARN_CHARS = 16000;

function topicsFilePath(userData: string): string {
  return join(userData, 'config', 'recall-topics.yaml');
}

/**
 * Load + validate the curated topic→canonical-doc map from
 * `<userData>/config/recall-topics.yaml` (shape `{ topics: TopicRule[] }`).
 * A rule needs a string `id` plus at least one match term and one doc path;
 * anything malformed is skipped. Missing file or any parse error → `[]` (logged
 * once). Never throws — the auto-recall hot path must degrade to "inject
 * nothing", never crash.
 */
export function loadRecallTopics(userData: string): TopicRule[] {
  const path = topicsFilePath(userData);
  if (!existsSync(path)) return [];
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as { topics?: unknown };
    const topics = raw?.topics;
    if (!Array.isArray(topics)) return [];
    const rules: TopicRule[] = [];
    for (const t of topics) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      if (typeof r.id !== 'string') continue;
      const match = Array.isArray(r.match)
        ? r.match.filter((m): m is string => typeof m === 'string')
        : [];
      const docs = Array.isArray(r.docs)
        ? r.docs.filter((d): d is string => typeof d === 'string')
        : [];
      if (match.length === 0 || docs.length === 0) continue;
      rules.push({ id: r.id, match, docs });
    }
    return rules;
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: surface a malformed topic map to the operator
    console.error(
      `[recall-topics] failed to load ${path}: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the rules whose ANY match term appears in `prompt` as a whole word
 * (case-insensitive, `\b` word boundaries — so "art" does not fire on
 * "started"). Result preserves map order; each rule appears at most once.
 */
export function matchTopics(prompt: string, rules: TopicRule[]): TopicRule[] {
  const hits: TopicRule[] = [];
  for (const rule of rules) {
    const hit = rule.match.some((term) => {
      const t = term.trim();
      if (!t) return false;
      return new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i').test(prompt);
    });
    if (hit) hits.push(rule);
  }
  return hits;
}

/**
 * For the `recall.topics_resolvable` doctor invariant: resolve each rule.docs
 * path under `userData`, reporting which are missing and which exceed
 * `DOC_SIZE_WARN_CHARS` (injected whole, so oversized docs tax every turn).
 * `topicCount` is the number of loaded rules.
 */
export function validateRecallTopics(userData: string): {
  topicCount: number;
  missingDocs: string[];
  oversizedDocs: Array<{ doc: string; chars: number }>;
} {
  const rules = loadRecallTopics(userData);
  const missing = new Set<string>();
  const oversized = new Map<string, number>();
  for (const rule of rules) {
    for (const doc of rule.docs) {
      const abs = join(userData, doc);
      if (!existsSync(abs)) {
        missing.add(doc);
        continue;
      }
      try {
        const { size } = statSync(abs);
        if (size > DOC_SIZE_WARN_CHARS) {
          // Post-slicer, an oversized doc with `##` sections is never injected whole —
          // auto-recall slices it to the query-relevant section (≤ the Layer-1 budget).
          // Only an un-sliceable (no-H2) oversized doc actually taxes every turn.
          const content = readFileSync(abs, 'utf8');
          if (!/^##\s+/m.test(content)) oversized.set(doc, size);
        }
      } catch {
        // stat/read failed (race, perms) — treat as resolvable; missing-check already passed.
      }
    }
  }
  return {
    topicCount: rules.length,
    missingDocs: [...missing],
    oversizedDocs: [...oversized].map(([doc, chars]) => ({ doc, chars })),
  };
}

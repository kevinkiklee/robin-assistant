import { CATEGORIES, UNCATEGORIZED } from './config.ts';

export type ClassifyResult =
  | { ok: true; category: string; warnings: string[] }
  | { ok: false; error: string };

function isBlank(v: unknown): boolean {
  return v == null || v === '';
}

/**
 * Resolve the `category` frontmatter value into a publish classification.
 * Pure — orchestrate.ts maps `{ok:false}` to a PublishError.
 *  - missing category  → Uncategorized + warning
 *  - unknown category  → reject
 *
 * `visibility` is accepted only as blank or 'public' (a harmless legacy no-op).
 * `visibility: private` is refused outright: private pages were removed
 * 2026-08-19 in favor of unguessable hashed URLs + a password-gated index, and
 * silently publishing a private-marked doc to a public URL would be a leak.
 */
export function classify(rawCategory: unknown, rawVisibility: unknown): ClassifyResult {
  const warnings: string[] = [];

  let category: string;
  if (isBlank(rawCategory)) {
    category = UNCATEGORIZED;
    warnings.push(`no category set — filed under "${UNCATEGORIZED}"`);
  } else if (typeof rawCategory !== 'string') {
    return { ok: false, error: `category must be a string, got ${typeof rawCategory}` };
  } else if (!(CATEGORIES as readonly string[]).includes(rawCategory)) {
    return {
      ok: false,
      error: `unknown category "${rawCategory}" — valid: ${CATEGORIES.join(', ')}`,
    };
  } else {
    category = rawCategory;
  }

  if (!isBlank(rawVisibility) && rawVisibility !== 'public') {
    if (rawVisibility === 'private') {
      return {
        ok: false,
        error:
          'visibility:private was removed 2026-08-19 — every page now publishes to an ' +
          'unguessable hashed URL and the index is password-gated. Drop the visibility field.',
      };
    }
    return {
      ok: false,
      error: `invalid visibility "${String(rawVisibility)}" — only 'public' (or omit) is accepted`,
    };
  }

  return { ok: true, category, warnings };
}

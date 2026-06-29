import { CATEGORIES, UNCATEGORIZED, VISIBILITIES } from './config.ts';

export type Visibility = (typeof VISIBILITIES)[number];

export type ClassifyResult =
  | { ok: true; category: string; visibility: Visibility; warnings: string[] }
  | { ok: false; error: string };

function isBlank(v: unknown): boolean {
  return v == null || v === '';
}

/**
 * Resolve the `category` and `visibility` frontmatter values into a publish
 * classification. Pure — orchestrate.ts maps `{ok:false}` to a PublishError.
 *  - missing category  → Uncategorized + warning
 *  - unknown category  → reject
 *  - missing visibility → public
 *  - invalid visibility → reject
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

  let visibility: Visibility;
  if (isBlank(rawVisibility)) {
    visibility = 'public';
  } else if (
    typeof rawVisibility === 'string' &&
    (VISIBILITIES as readonly string[]).includes(rawVisibility)
  ) {
    visibility = rawVisibility as Visibility;
  } else {
    return { ok: false, error: `invalid visibility "${String(rawVisibility)}" — valid: ${VISIBILITIES.join(', ')}` };
  }

  return { ok: true, category, visibility, warnings };
}

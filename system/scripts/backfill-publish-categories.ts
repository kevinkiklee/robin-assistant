import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBlobClient } from '../lib/publish/blob.ts';
import { UNCATEGORIZED } from '../lib/publish/config.ts';
import { readLog } from '../lib/publish/log.ts';
import { writeManifest } from '../lib/publish/manifest.ts';
import type { LogRow } from '../lib/publish/types.ts';
import { resolveUserDataDir } from '../lib/paths.ts';
import { loadEnvFile } from '../lib/secrets/load-env.ts';

/** Exact slug → category overrides (anything the prefix rules don't nail). */
const OVERRIDES: Record<string, string> = {
  'jamaica-bay-sunrise-birding': 'Field Guides',
  'jamaica-bay-sunday-birding': 'Field Guides',
  'constitution-marsh-photography': 'Field Guides',
  'fog-photography-night-predawn-dawn': 'Field Guides',
  'astoria-fog-nocturne': 'Field Guides',
  'west-village-photo-walk': 'Field Guides',
  'nyc-organic-graffiti-photo-guide': 'Field Guides',
  'randalls-island-birds-this-morning': 'Field Guides',
  'still-up': 'Field Guides',
  'golden-hour-warm-preset-guide': 'Color Grading',
  'ugreen-nas-setup-guide': 'Tools & Setup',
  'jake-local-dev': 'Tools & Setup',
  'jake-cheat-sheet': 'Tools & Setup',
  'zf-night-flash-cheatsheet': 'Tools & Setup',
  'nikon-z8-setup': 'Tools & Setup',
  'nikon-user-modes-and-banks': 'Tools & Setup',
  'photographer-profile': 'Essays',
  'photography-practice': 'Essays',
  'kevin-as-photographer': 'Essays',
  'the-buff': 'Essays',
  'getting-to-webb': 'Essays',
  'ten-color-photos': 'Essays',
  'favorite-photos': 'Essays',
  'prime-vs-zoom-street': 'Gear & Comparisons',
  'nikon-sensor-iq-zf-zfc-z50ii-z8': 'Gear & Comparisons',
  'nokton-classic-35-f8-street': 'Essays',
  'fashion-week-queens-shoot-plan': 'Field Guides',
  // prompt / meta artifacts — see STARTER_PRIVATE below
  'critique-prompt': 'Tools & Setup',
  'photo-critique-prompt': 'Tools & Setup',
  'color-grade-skill': 'Tools & Setup',
  'color-grade-assistant': 'Tools & Setup',
};

/**
 * Slugs to flip to visibility:private during backfill. EMPTY by design
 * (decision 2: all stay public). Uncomment entries to hide them immediately.
 */
const STARTER_PRIVATE = new Set<string>([
  // 'critique-prompt',
  // 'photo-critique-prompt',
  // 'kevin-as-photographer',
]);

export function categoryForSlug(slug: string): string {
  if (OVERRIDES[slug]) return OVERRIDES[slug];
  if (slug.startsWith('lens-')) return 'Lens Analysis';
  if (slug.startsWith('critique-')) return 'Critiques';
  if (slug.startsWith('color-grade-')) return 'Color Grading';
  if (slug.startsWith('trading-') || slug.includes('trading')) return 'Projects';
  if (slug.startsWith('tc-') || slug.includes('teleconverter') || slug.includes('-vs-')) {
    return 'Gear & Comparisons';
  }
  if (slug.includes('600-pf') || slug.includes('180-600') || slug.includes('100-400')) {
    return 'Gear & Comparisons';
  }
  if (slug.includes('lens-comparison') || slug.includes('three-35') || slug === '35mm-lens-comparison') {
    return 'Lens Analysis';
  }
  return UNCATEGORIZED;
}

function patchRow(row: LogRow): LogRow {
  return {
    ...row,
    category: row.category ?? categoryForSlug(row.slug),
    visibility: row.visibility ?? (STARTER_PRIVATE.has(row.slug) ? 'private' : 'public'),
    description: row.description ?? null,
  };
}

async function main(): Promise<void> {
  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const userId = process.env.PUBLISH_USER_ID;
  const publicUrl = process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io';
  if (!token || !userId) throw new Error('BLOB_READ_WRITE_TOKEN and PUBLISH_USER_ID required');

  const logPath = join(userData, 'observability', 'publish', 'index.jsonl');
  const { entries } = await readLog(logPath);

  // 1. snapshot
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(`${logPath}.bak-${stamp}`, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 2. patch in memory
  const patched = entries.map(patchRow);

  // 3. atomic rewrite (temp + rename)
  const tmp = `${logPath}.tmp-${stamp}`;
  await writeFile(tmp, patched.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await rename(tmp, logPath);

  // 4. rebuild both manifests
  const blob = createBlobClient({ token });
  const privateBlob = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN
    ? createBlobClient({ token: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN })
    : null;
  await writeManifest(blob, { publicUrl, userId }, patched, privateBlob);

  process.stdout.write(`backfilled ${patched.length} rows; manifests rebuilt.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

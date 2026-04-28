import { existsSync, readdirSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateConfig } from './lib/config-migrate.js';

const COPY_FILES = [
  'profile.md', 'knowledge.md', 'tasks.md', 'decisions.md',
  'journal.md', 'inbox.md', 'integrations.md', 'manifest.md',
  'robin.config.json',
];
const COPY_DIRS = ['state', 'index', 'trips'];

export async function migrateV3(workspaceDir, { from }) {
  if (!from) throw new Error('migrate-v3 requires --from <path>');
  if (!existsSync(from)) throw new Error(`source not found: ${from}`);

  const ud = join(workspaceDir, 'user-data');
  if (existsSync(ud) && readdirSync(ud).length > 0) {
    throw new Error(`target user-data/ is not empty: ${ud}`);
  }
  mkdirSync(ud, { recursive: true });

  const summary = { copied: [], skipped: [] };

  for (const f of COPY_FILES) {
    const src = join(from, f);
    if (existsSync(src)) {
      cpSync(src, join(ud, f));
      summary.copied.push(f);
    }
  }
  for (const d of COPY_DIRS) {
    const src = join(from, d);
    if (existsSync(src)) {
      cpSync(src, join(ud, d), { recursive: true });
      summary.copied.push(d + '/');
    }
  }

  // Split self-improvement.md: drop the rules section, keep user log
  const siSrc = join(from, 'self-improvement.md');
  if (existsSync(siSrc)) {
    const content = readFileSync(siSrc, 'utf-8');
    // Heuristic: find the first occurrence of "## Corrections" (or fallback)
    const m = content.match(/##\s+(Corrections|Patterns|Calibration)/);
    if (m) {
      const userPart = content.slice(content.indexOf(m[0]));
      writeFileSync(join(ud, 'self-improvement.md'), userPart);
    } else {
      writeFileSync(join(ud, 'self-improvement.md'), content);
    }
    summary.copied.push('self-improvement.md (split)');
  }

  // Migrate archive/ → backup/
  const arc = join(from, 'archive');
  if (existsSync(arc)) {
    const tgt = join(workspaceDir, 'backup');
    mkdirSync(tgt, { recursive: true });
    for (const f of readdirSync(arc)) cpSync(join(arc, f), join(tgt, f), { recursive: true });
    summary.copied.push('archive/ → backup/');
  }

  // Drop artifacts/ — retired
  if (existsSync(join(from, 'artifacts'))) summary.skipped.push('artifacts/ (retired)');
  for (const skip of ['.DS_Store', '.claude', '.git', 'mcps', 'share', 'package.json', 'README.md', 'docs']) {
    if (existsSync(join(from, skip))) summary.skipped.push(skip);
  }

  // Set version to 3.0.0
  const cfgPath = join(ud, 'robin.config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.version = '3.0.0';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }

  // Apply additive config migration
  await migrateConfig(workspaceDir);

  console.log('Migration summary:');
  summary.copied.forEach(c => console.log(`  + ${c}`));
  summary.skipped.forEach(c => console.log(`  - ${c} (skipped)`));
  console.log(`\nSource untouched at ${from}; delete when satisfied.`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx > -1 ? process.argv[fromIdx + 1] : null;
  await migrateV3(process.cwd(), { from });
}

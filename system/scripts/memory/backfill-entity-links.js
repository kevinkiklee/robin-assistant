import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { applyEntityLinks } from '../wiki-graph/lib/apply-entity-links.js';
import { buildEntityRegistry } from '../wiki-graph/lib/build-entity-registry.js';
import { isExcludedPath } from '../wiki-graph/lib/exclusions.js';
import { acquireLock, releaseLock } from '../jobs/lib/atomic.js';
import { writeLinksIndex } from './regenerate-links.js';

async function* walkMd(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      yield* walkMd(full, base);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield relative(base, full).split(/[\\/]/).join('/');
    }
  }
}

function inScope(relPath, scope) {
  if (scope === 'all') return true;
  if (scope === 'profile') return relPath.startsWith('profile/');
  if (scope === 'service-providers') return relPath.startsWith('knowledge/service-providers/');
  return relPath.startsWith(`knowledge/${scope}/`);
}

export async function runBackfill({ workspaceDir, scope = 'all', apply = false, reportDir }) {
  const memoryRoot = join(workspaceDir, 'user-data', 'memory');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = reportDir || join(workspaceDir, 'user-data', 'artifacts', `wiki-graph-${ts}`);
  await mkdir(outDir, { recursive: true });

  let lockPath = null;
  if (apply) {
    const locksDir = join(workspaceDir, '.locks');
    if (!existsSync(locksDir)) mkdirSync(locksDir, { recursive: true });
    lockPath = join(locksDir, 'wiki-backfill.lock');
    const reason = acquireLock(lockPath);
    if (reason) throw new Error(`wiki-graph: another backfill is in progress (lock ${reason})`);
  }

  try {
    const registry = await buildEntityRegistry(workspaceDir);

    let totalInserted = 0;
    let filesTouched = 0;
    const reportLines = [];

    for await (const relPath of walkMd(memoryRoot)) {
      if (isExcludedPath(relPath)) continue;
      if (!inScope(relPath, scope)) continue;

      const result = await applyEntityLinks(workspaceDir, relPath, registry, { dryRun: !apply });
      const hasErrors = result.errors && result.errors.length > 0;
      if (result.inserted > 0 || hasErrors) {
        if (result.inserted > 0) {
          totalInserted += result.inserted;
          filesTouched += 1;
        }
        reportLines.push(`## ${relPath}`);
        reportLines.push(`- inserted: ${result.inserted}`);
        if (hasErrors) {
          reportLines.push(`- errors: [${result.errors.join(', ')}]`);
        }
        reportLines.push('');
      }
    }

    if (apply) {
      writeLinksIndex(memoryRoot, workspaceDir);
    }

    await writeFile(
      join(outDir, 'report.md'),
      `# Wiki-graph backfill ${apply ? '(applied)' : '(dry-run)'}\n\n` +
      `- scope: ${scope}\n- files touched: ${filesTouched}\n- total insertions: ${totalInserted}\n\n` +
      reportLines.join('\n')
    );

    return { reportDir: outDir, totalInserted, filesTouched };
  } finally {
    if (lockPath) releaseLock(lockPath);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const __filename = fileURLToPath(import.meta.url);
  const workspaceDir = process.env.ROBIN_WORKSPACE || join(dirname(__filename), '..', '..', '..');
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const scopeIdx = argv.indexOf('--scope');
  const scope = scopeIdx >= 0 ? argv[scopeIdx + 1] : 'all';
  const r = await runBackfill({ workspaceDir, scope, apply });
  console.log(`backfill: ${r.filesTouched} files, ${r.totalInserted} insertions, report at ${r.reportDir}`);
}

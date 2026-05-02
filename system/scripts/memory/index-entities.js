#!/usr/bin/env node
// system/scripts/memory/index-entities.js
//
// Generates user-data/memory/ENTITIES.md from topic-file frontmatter.
//
// Modes:
//   --regenerate   refresh ENTITIES.md if content changed (Dream Phase 4.17.6)
//   --bootstrap    one-shot at install/upgrade; prints aliases backfill report
//   --json         machine-readable status for scripting

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { collectEntities, writeEntitiesAtomic, detectUserEdit } from './lib/entity-index.js';

const ENTITIES_FILE = 'user-data/memory/ENTITIES.md';

/** Read the `generated:` timestamp from an existing ENTITIES.md frontmatter, if present. */
function readExistingGenerated(workspaceDir) {
  const file = join(workspaceDir, ENTITIES_FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^generated:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function parseArgs(argv) {
  const args = { mode: null, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--regenerate') args.mode = 'regenerate';
    else if (a === '--bootstrap') args.mode = 'bootstrap';
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main() {
  const ws = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const args = parseArgs(process.argv);

  if (args.mode === 'regenerate') {
    if (detectUserEdit(ws)) {
      process.stderr.write(
        'index-entities: ENTITIES.md was user-edited since last regenerate; aborting to preserve manual changes. ' +
        'Restore the auto-generated content (or delete it) before retrying.\n',
      );
      process.exit(2);
    }
    const entities = collectEntities(ws);
    // Preserve the existing `generated` timestamp so the file content (and its hash)
    // only changes when entity data actually changes — this is what makes regeneration idempotent.
    const existingGenerated = readExistingGenerated(ws);
    const opts = existingGenerated ? { generated: existingGenerated } : {};
    writeEntitiesAtomic(ws, entities, opts);
    if (args.json) process.stdout.write(JSON.stringify({ entities: entities.length }) + '\n');
    else process.stdout.write(`Regenerated ENTITIES.md: ${entities.length} entities.\n`);
    process.exit(0);
  }

  if (args.mode === 'bootstrap') {
    const entities = collectEntities(ws);
    writeEntitiesAtomic(ws, entities);
    const noAlias = entities.filter((e) => e.aliases.length === 0).map((e) => e.file);
    process.stdout.write(`Indexed ${entities.length} entities.\n`);
    if (noAlias.length > 0) {
      process.stdout.write(`${noAlias.length} files would benefit from explicit \`aliases:\` frontmatter:\n`);
      for (const f of noAlias.slice(0, 20)) process.stdout.write(`  - ${f}\n`);
      if (noAlias.length > 20) process.stdout.write(`  ... and ${noAlias.length - 20} more\n`);
    }
    process.exit(0);
  }

  process.stderr.write('Usage: index-entities.js [--regenerate|--bootstrap] [--json]\n');
  process.exit(1);
}

main();

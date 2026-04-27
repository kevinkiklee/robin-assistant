/**
 * migrate-index.js — Phase A structural migration script.
 *
 * Upgrades a v2.0.0 Robin workspace to v2.1.0 by:
 *   1. Backing up all user data files to archive/pre-index-<date>/
 *   2. Parsing entries, assigning migration IDs, injecting IDs into source files
 *   3. Generating skeleton index files for each data file
 *   4. Creating the index/ directory and manifest.md
 *   5. Updating robin.config.json (or arc.config.json) to v2.1.0
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, basename } from 'path';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';
import {
  generateMigrationId,
  parseAppendOnlyEntries,
  parseReferenceEntries,
  parseTaskEntries,
  injectIdsIntoFile,
  generateSkeletonIndex,
  generateManifest,
} from './lib/index-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the file mtime as a YYYY-MM-DD string.
 */
function fileDateFallback(filePath) {
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Extracts unique ## section headers from markdown content.
 */
function extractSections(content) {
  const sections = [];
  const re = /^## (.+)$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const section = m[1].trim();
    if (!sections.includes(section)) sections.push(section);
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

/**
 * Migrates a single Robin workspace directory to v2.1.0 with memory indexing.
 *
 * @param {string} workspaceDir — absolute path to workspace root
 */
export async function migrateIndexInDir(workspaceDir) {
  // ------------------------------------------------------------------
  // 1. Backup
  // ------------------------------------------------------------------
  const archiveDir = join(workspaceDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });

  // Check if a pre-index-* backup already exists
  const existingBackup = readdirSync(archiveDir).find(e => e.startsWith('pre-index-'));

  if (!existingBackup) {
    const date = new Date().toISOString().slice(0, 10);
    const backupDir = join(archiveDir, `pre-index-${date}`);
    mkdirSync(backupDir, { recursive: true });

    for (const file of USER_DATA_FILES) {
      const src = join(workspaceDir, file);
      if (existsSync(src)) {
        cpSync(src, join(backupDir, file));
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Process each file — parse, assign IDs, inject, generate index
  // ------------------------------------------------------------------

  // Global sequential counter shared across all files
  let seq = 0;

  const manifestEntries = [];

  // Helper: process a reference file (profile.md, knowledge.md)
  function processReferenceFile(fileName) {
    const filePath = join(workspaceDir, fileName);
    if (!existsSync(filePath)) {
      // Generate empty index
      const idxContent = generateSkeletonIndex(fileName, [], 'fact');
      return { content: null, indexContent: idxContent, entryCount: 0, sections: [] };
    }

    const content = readFileSync(filePath, 'utf-8');
    const fallbackDate = fileDateFallback(filePath);
    const entries = parseReferenceEntries(content);

    const assignments = [];
    const indexEntries = [];

    for (const entry of entries) {
      seq += 1;
      const id = generateMigrationId(null, seq, fallbackDate);
      assignments.push({ lineIndex: entry.lineIndex, id, type: 'inline' });
      indexEntries.push({ id, section: entry.section, entity: entry.entity, text: entry.text });
    }

    const newContent = injectIdsIntoFile(content, assignments);
    const sections = extractSections(content);
    const idxContent = generateSkeletonIndex(fileName, indexEntries, 'fact');

    return { content: newContent, indexContent: idxContent, entryCount: indexEntries.length, sections };
  }

  // Helper: process a task file (tasks.md)
  function processTaskFile(fileName) {
    const filePath = join(workspaceDir, fileName);
    if (!existsSync(filePath)) {
      const idxContent = generateSkeletonIndex(fileName, [], 'entry');
      return { content: null, indexContent: idxContent, entryCount: 0, sections: [] };
    }

    const content = readFileSync(filePath, 'utf-8');
    const fallbackDate = fileDateFallback(filePath);
    const entries = parseTaskEntries(content);

    const assignments = [];
    const indexEntries = [];

    for (const entry of entries) {
      seq += 1;
      const id = generateMigrationId(null, seq, fallbackDate);
      assignments.push({ lineIndex: entry.lineIndex, id, type: 'inline' });
      indexEntries.push({ id, section: entry.section, text: entry.text });
    }

    const newContent = injectIdsIntoFile(content, assignments);
    const sections = extractSections(content);
    const idxContent = generateSkeletonIndex(fileName, indexEntries, 'entry');

    return { content: newContent, indexContent: idxContent, entryCount: indexEntries.length, sections };
  }

  // Helper: process an append-only file (journal.md, decisions.md, inbox.md)
  function processAppendOnlyFile(fileName) {
    const filePath = join(workspaceDir, fileName);
    if (!existsSync(filePath)) {
      const idxContent = generateSkeletonIndex(fileName, [], 'entry');
      return { content: null, indexContent: idxContent, entryCount: 0, sections: [] };
    }

    const content = readFileSync(filePath, 'utf-8');
    const fallbackDate = fileDateFallback(filePath);
    const entries = parseAppendOnlyEntries(content);

    // We need to find the line index for each entry in the original content
    const lines = content.split('\n');

    const assignments = [];
    const indexEntries = [];
    const usedLines = new Set();

    for (const entry of entries) {
      seq += 1;
      const id = generateMigrationId(entry.date, seq, fallbackDate);

      // Find the line index of this entry in the content
      const entryFirstLine = entry.text.split('\n')[0];
      let lineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === entryFirstLine.trim()) {
          // Make sure this line doesn't already have an id and hasn't been used
          if (!lines[i].includes('<!-- id:') && !usedLines.has(i)) {
            lineIndex = i;
            break;
          }
        }
      }

      if (lineIndex >= 0) {
        usedLines.add(lineIndex);
        assignments.push({ lineIndex, id, type: 'block' });
      }
      indexEntries.push({ id, text: entry.text });
    }

    const newContent = injectIdsIntoFile(content, assignments);
    const sections = extractSections(content);
    const idxContent = generateSkeletonIndex(fileName, indexEntries, 'entry');

    return { content: newContent, indexContent: idxContent, entryCount: indexEntries.length, sections };
  }

  // Helper: process self-improvement.md (empty skeleton index)
  function processSelfImprovementFile(fileName) {
    const filePath = join(workspaceDir, fileName);
    const sections = existsSync(filePath)
      ? extractSections(readFileSync(filePath, 'utf-8'))
      : [];
    const idxContent = generateSkeletonIndex(fileName, [], 'entry');
    return { content: null, indexContent: idxContent, entryCount: 0, sections };
  }

  // Helper: scan trips/ directory for .md files
  function processTripsDirectory() {
    const tripsDir = join(workspaceDir, 'trips');
    const indexEntries = [];

    if (existsSync(tripsDir)) {
      const files = readdirSync(tripsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        seq += 1;
        const slug = basename(file, '.md');
        const filePath = join(tripsDir, file);
        const fallbackDate = fileDateFallback(filePath);
        const id = generateMigrationId(null, seq, fallbackDate);
        indexEntries.push({ id, entity: slug, section: 'Trips', text: slug });
      }
    }

    const idxContent = generateSkeletonIndex('trips', indexEntries, 'fact');
    return { indexContent: idxContent, entryCount: indexEntries.length };
  }

  // Process each file
  const profileResult = processReferenceFile('profile.md');
  const knowledgeResult = processReferenceFile('knowledge.md');
  const tasksResult = processTaskFile('tasks.md');
  const journalResult = processAppendOnlyFile('journal.md');
  const decisionsResult = processAppendOnlyFile('decisions.md');
  const inboxResult = processAppendOnlyFile('inbox.md');
  const selfImprovementResult = processSelfImprovementFile('self-improvement.md');
  const tripsResult = processTripsDirectory();

  // Write modified source files back
  const fileResults = [
    { name: 'profile.md', result: profileResult },
    { name: 'knowledge.md', result: knowledgeResult },
    { name: 'tasks.md', result: tasksResult },
    { name: 'journal.md', result: journalResult },
    { name: 'decisions.md', result: decisionsResult },
    { name: 'inbox.md', result: inboxResult },
    { name: 'self-improvement.md', result: selfImprovementResult },
  ];

  for (const { name, result } of fileResults) {
    if (result.content !== null) {
      writeFileSync(join(workspaceDir, name), result.content);
    }
  }

  // ------------------------------------------------------------------
  // 3. Create index/ directory and write index files
  // ------------------------------------------------------------------
  const indexDir = join(workspaceDir, 'index');
  mkdirSync(indexDir, { recursive: true });

  const indexFileMap = [
    { name: 'profile', idxFile: 'profile.idx.md', result: profileResult },
    { name: 'knowledge', idxFile: 'knowledge.idx.md', result: knowledgeResult },
    { name: 'tasks', idxFile: 'tasks.idx.md', result: tasksResult },
    { name: 'journal', idxFile: 'journal.idx.md', result: journalResult },
    { name: 'decisions', idxFile: 'decisions.idx.md', result: decisionsResult },
    { name: 'inbox', idxFile: 'inbox.idx.md', result: inboxResult },
    { name: 'self-improvement', idxFile: 'self-improvement.idx.md', result: selfImprovementResult },
    { name: 'trips', idxFile: 'trips.idx.md', result: tripsResult },
  ];

  for (const { idxFile, result } of indexFileMap) {
    writeFileSync(join(indexDir, idxFile), result.indexContent);
  }

  // ------------------------------------------------------------------
  // 4. Generate manifest
  // ------------------------------------------------------------------
  for (const { name, idxFile, result } of indexFileMap) {
    const srcName = name === 'trips' ? 'trips/' : `${name}.md`;
    let type;
    if (['profile', 'knowledge', 'trips'].includes(name)) {
      type = 'reference';
    } else if (['tasks', 'self-improvement'].includes(name)) {
      type = 'mixed';
    } else {
      // journal, decisions, inbox
      type = 'append-only';
    }
    manifestEntries.push({
      name: srcName,
      path: srcName,
      indexPath: `index/${idxFile}`,
      type,
      entries: result.entryCount,
      domains: [],
      sections: result.sections || [],
    });
  }

  const manifestContent = generateManifest(manifestEntries);
  writeFileSync(join(workspaceDir, 'manifest.md'), manifestContent);

  // ------------------------------------------------------------------
  // 4b. Post-migration validation: verify entry counts match between
  //     source files and their generated index files.
  // ------------------------------------------------------------------
  const backupDirName = readdirSync(join(workspaceDir, 'archive')).find(e =>
    e.startsWith('pre-index-')
  );
  const backupPath = backupDirName
    ? join(workspaceDir, 'archive', backupDirName)
    : null;

  const appendOnlyFiles = ['journal.md', 'decisions.md', 'inbox.md'];
  for (const srcFile of appendOnlyFiles) {
    const srcPath = join(workspaceDir, srcFile);
    if (!existsSync(srcPath)) continue;

    const srcContent = readFileSync(srcPath, 'utf-8');
    const sourceCount = (srcContent.match(/<!--\s*id:/g) || []).length;

    const baseName = srcFile.replace('.md', '');
    const idxPath = join(indexDir, `${baseName}.idx.md`);
    if (!existsSync(idxPath)) continue;

    const idxContent = readFileSync(idxPath, 'utf-8');
    const indexCount = idxContent.split('\n').filter(l => /^- id:/.test(l)).length;

    if (sourceCount !== indexCount) {
      console.warn(
        `Warning: entry count mismatch in ${srcFile} (source: ${sourceCount}, index: ${indexCount})`
      );
      if (backupPath) {
        console.warn(`  Backup available at: ${backupPath}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. Update config
  // ------------------------------------------------------------------
  let configPath = join(workspaceDir, 'robin.config.json');
  if (!existsSync(configPath)) {
    configPath = join(workspaceDir, 'arc.config.json');
  }

  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.version = '2.1.0';
    config.indexing = {
      status: 'structural',
      migrated_at: new Date().toISOString(),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  console.log('Memory indexing migration complete.');
  console.log('Skeleton indexes generated in index/. Manifest written to manifest.md.');
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entry point — locates the workspace via findConfig() and runs migration.
 */
export async function migrateIndex(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error("Error: No Robin workspace found. Run 'robin init' to create one.");
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  await migrateIndexInDir(workspaceDir);
}

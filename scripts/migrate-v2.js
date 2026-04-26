import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { findConfig } from './lib/find-config.js';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function migrateV2(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  await migrateV2InDir(workspaceDir, pkgRoot);
}

export async function migrateV2InDir(workspaceDir, pkgRoot) {
  const configPath = join(workspaceDir, 'arc.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (config.version === '2.0.0') {
    console.log('Already on v2.');
    return;
  }

  console.log('Migrating to v2...');

  const date = new Date().toISOString().slice(0, 10);
  const backupDir = join(workspaceDir, 'archive', `pre-v2-${date}`);
  mkdirSync(backupDir, { recursive: true });

  const v1Dirs = [
    'core', 'profile', 'memory', 'todos', 'knowledge', 'decisions',
    'journal', 'inbox', 'skills', 'self-improvement', 'overrides', 'share',
  ];
  for (const dir of v1Dirs) {
    const src = join(workspaceDir, dir);
    if (existsSync(src)) {
      cpSync(src, join(backupDir, dir), { recursive: true });
    }
  }
  for (const file of ['CLAUDE.md', 'arc.config.json']) {
    const src = join(workspaceDir, file);
    if (existsSync(src)) cpSync(src, join(backupDir, file));
  }

  const profileMd = mergeDirectory(join(workspaceDir, 'profile'), 'Profile');
  const tasksMd = mergeDirectory(join(workspaceDir, 'todos'), 'Tasks');
  const knowledgeMd = mergeKnowledge(join(workspaceDir, 'knowledge'));
  const decisionsMd = mergeChronological(join(workspaceDir, 'decisions'), 'Decisions');
  const journalMd = mergeChronological(join(workspaceDir, 'journal'), 'Journal');
  const selfImprovementMd = mergeSelfImprovement(join(workspaceDir, 'self-improvement'));
  const inboxMd = readIfExists(join(workspaceDir, 'inbox', 'inbox.md')) || '# Inbox\n';

  const longTermDir = join(workspaceDir, 'memory', 'long-term');
  if (existsSync(longTermDir)) {
    const ltContent = collectMdFiles(longTermDir);
    if (ltContent.trim()) {
      const migratedSection = '\n\n## Migrated (review needed)\n\n' + ltContent;
      const kLines = knowledgeMd + migratedSection;
      writeFileSync(join(workspaceDir, 'knowledge.md'), kLines);
    } else {
      writeFileSync(join(workspaceDir, 'knowledge.md'), knowledgeMd);
    }
  } else {
    writeFileSync(join(workspaceDir, 'knowledge.md'), knowledgeMd);
  }

  writeFileSync(join(workspaceDir, 'profile.md'), profileMd);
  writeFileSync(join(workspaceDir, 'tasks.md'), tasksMd);
  writeFileSync(join(workspaceDir, 'decisions.md'), decisionsMd);
  writeFileSync(join(workspaceDir, 'journal.md'), journalMd);
  writeFileSync(join(workspaceDir, 'self-improvement.md'), selfImprovementMd);
  writeFileSync(join(workspaceDir, 'inbox.md'), inboxMd);

  const shortTermDir = join(workspaceDir, 'memory', 'short-term');
  let dreamStateContent = '# Dream State\n\nlast_dream_at: null\nsessions_since: 0\nstatus: migrated\nlast_run_session: null\n\n## Last summary\n\nMigrated from v1.\n\n## Deferred items\n\n(none)\n';

  if (existsSync(shortTermDir)) {
    const lastDream = join(shortTermDir, 'last-dream.md');
    if (existsSync(lastDream)) {
      const content = readFileSync(lastDream, 'utf-8');
      const atMatch = content.match(/last_dream_at:\s*(.+)/);
      const sinceMatch = content.match(/sessions_since:\s*(\d+)/);
      const statusMatch = content.match(/status:\s*(.+)/);
      dreamStateContent = `# Dream State\n\nlast_dream_at: ${atMatch ? atMatch[1].trim() : 'null'}\nsessions_since: ${sinceMatch ? sinceMatch[1].trim() : '0'}\nstatus: ${statusMatch ? statusMatch[1].trim() : 'migrated'}\nlast_run_session: null\n\n## Last summary\n\nMigrated from v1.\n\n## Deferred items\n\n(none)\n`;
    }

    const stFiles = readdirSync(shortTermDir).filter(f => f !== 'last-dream.md' && f.endsWith('.md'));
    if (stFiles.length > 0) {
      let inboxAppend = '\n\n## Migrated from short-term memory\n\n';
      for (const f of stFiles) {
        const content = readFileContent(join(shortTermDir, f));
        if (content.trim()) inboxAppend += `### ${basename(f, '.md')}\n\n${content}\n\n`;
      }
      const currentInbox = readFileSync(join(workspaceDir, 'inbox.md'), 'utf-8');
      writeFileSync(join(workspaceDir, 'inbox.md'), currentInbox + inboxAppend);
    }
  }

  mkdirSync(join(workspaceDir, 'state', 'locks'), { recursive: true });
  writeFileSync(join(workspaceDir, 'state', 'dream-state.md'), dreamStateContent);

  const templatesDir = join(pkgRoot, 'templates');
  cpSync(join(templatesDir, 'state', 'sessions.md'), join(workspaceDir, 'state', 'sessions.md'));

  for (const file of ['AGENTS.md', 'startup.md', 'capture-rules.md']) {
    cpSync(join(templatesDir, file), join(workspaceDir, file));
  }

  const protocolsDest = join(workspaceDir, 'protocols');
  if (existsSync(protocolsDest)) rmSync(protocolsDest, { recursive: true });
  cpSync(join(templatesDir, 'protocols'), protocolsDest, { recursive: true });

  const platform = config.platform || 'claude-code';
  const platformConfig = PLATFORMS[platform];
  if (platformConfig?.pointerFile) {
    writeFileSync(join(workspaceDir, platformConfig.pointerFile), platformConfig.pointerContent);
  }

  const integrations = Array.isArray(config.integrations)
    ? config.integrations.filter(i => typeof i === 'string')
    : [];
  writeFileSync(join(workspaceDir, 'integrations.md'), generateIntegrationsMd(platform, integrations));

  const newConfig = {
    version: '2.0.0',
    initialized: config.initialized ?? true,
    platform,
    user: config.user || { name: null, timezone: null, email: null },
    assistant: config.assistant || { name: 'Arc' },
    integrations,
  };
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n');

  for (const dir of v1Dirs) {
    const p = join(workspaceDir, dir);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  mkdirSync(join(workspaceDir, 'artifacts'), { recursive: true });
  mkdirSync(join(workspaceDir, 'archive'), { recursive: true });

  console.log(`Migration complete. Your pre-v2 workspace is backed up in archive/pre-v2-${date}/.`);
  console.log('Review the changes with `git diff` and commit when satisfied.');
  console.log('Long-term memory files were migrated to knowledge.md — review the "Migrated" section.');
}

function mergeDirectory(dirPath, title) {
  if (!existsSync(dirPath)) return `# ${title}\n`;

  const lines = [`# ${title}\n`];
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'TEMPLATE.md' && f !== 'README.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    const sectionName = basename(file, '.md');
    const capitalized = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
    lines.push(`\n## ${capitalized}\n`);
    lines.push(stripTopHeader(content));
  }

  return lines.join('\n') + '\n';
}

function mergeKnowledge(dirPath) {
  if (!existsSync(dirPath)) return '# Knowledge\n';

  const lines = ['# Knowledge\n'];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'INDEX.md' || entry.name === 'README.md') continue;

    if (entry.isDirectory()) {
      const subDir = join(dirPath, entry.name);
      const subFiles = readdirSync(subDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md');
      const capitalized = entry.name.charAt(0).toUpperCase() + entry.name.slice(1);
      lines.push(`\n## ${capitalized}\n`);
      for (const f of subFiles) {
        const content = readFileContent(join(subDir, f));
        if (!content.trim() || isEmptyTemplate(content)) continue;
        lines.push(stripTopHeader(content));
      }
    } else if (entry.name.endsWith('.md')) {
      const content = readFileContent(join(dirPath, entry.name));
      if (!content.trim() || isEmptyTemplate(content)) continue;
      const sectionName = basename(entry.name, '.md');
      const capitalized = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
      lines.push(`\n## ${capitalized}\n`);
      lines.push(stripTopHeader(content));
    }
  }

  return lines.join('\n') + '\n';
}

function mergeChronological(dirPath, title) {
  if (!existsSync(dirPath)) return `# ${title}\n\nAppend-only. Newest at the bottom.\n\n<!-- APPEND-ONLY below this line -->\n`;

  const lines = [`# ${title}\n\nAppend-only. Newest at the bottom.\n\n<!-- APPEND-ONLY below this line -->\n`];
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'TEMPLATE.md' && f !== 'README.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    lines.push(`\n### ${basename(file, '.md')}\n`);
    lines.push(stripTopHeader(content));
  }

  return lines.join('\n') + '\n';
}

function mergeSelfImprovement(dirPath) {
  if (!existsSync(dirPath)) return '# Self-Improvement\n\n## Corrections\n\n## Patterns\n\n## Session Handoff\n\n## Calibration\n';

  const sectionMap = {
    corrections: '## Corrections',
    feedback: '## Corrections',
    mistakes: '## Corrections',
    'observed-patterns': '## Patterns',
    'known-patterns': '## Patterns',
    patterns: '## Patterns',
    'session-handoff': '## Session Handoff',
    predictions: '## Calibration',
    'skill-usage': '## Calibration',
    wins: '## Calibration',
    'blind-spots': '## Patterns',
    'near-misses': '## Corrections',
    improvements: '## Patterns',
  };

  const sections = {
    '## Corrections': [],
    '## Patterns': [],
    '## Session Handoff': [],
    '## Calibration': [],
  };

  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    const key = basename(file, '.md');
    const section = sectionMap[key] || '## Corrections';
    sections[section].push(stripTopHeader(content));
  }

  const lines = ['# Self-Improvement\n'];
  for (const [header, contents] of Object.entries(sections)) {
    lines.push(`\n${header}\n`);
    for (const c of contents) {
      if (c.trim()) lines.push(c);
    }
  }

  return lines.join('\n') + '\n';
}

function readFileContent(filePath) {
  try { return readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function readIfExists(filePath) {
  try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function stripTopHeader(content) {
  return content.replace(/^#\s+.+\n+/, '');
}

function isEmptyTemplate(content) {
  const stripped = content.replace(/^#.+$/gm, '').replace(/<!--.*?-->/gs, '').trim();
  return stripped.length < 10;
}

function collectMdFiles(dirPath) {
  const lines = [];
  const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const content = readFileContent(join(dirPath, f));
    if (content.trim() && !isEmptyTemplate(content)) {
      lines.push(`### ${basename(f, '.md')}\n\n${stripTopHeader(content)}`);
    }
  }
  return lines.join('\n\n');
}

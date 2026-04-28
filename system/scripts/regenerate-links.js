import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

const SKIP_FILES = new Set(['INDEX.md', 'LINKS.md', '.gitkeep']);

function loadConfig(workspaceDir) {
  const configPath = join(workspaceDir, 'user-data', 'robin.config.json');
  if (!existsSync(configPath)) return { graph_exclude: [] };
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return config.memory ?? { graph_exclude: [] };
}

function isExcluded(relPath, excludePatterns) {
  return excludePatterns.some(pattern => relPath.startsWith(pattern));
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_FILES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, base));
    } else if (name.endsWith('.md')) {
      out.push(relative(base, full).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

function extractLinks(content, fromPath) {
  const fromDir = posix.dirname(fromPath);
  const links = [];
  let match;
  while ((match = LINK_RE.exec(content)) !== null) {
    const target = match[2];
    if (target.match(/^[a-z][a-z0-9+.-]*:/i)) continue;
    if (target.startsWith('#')) continue;
    if (!target.endsWith('.md')) continue;
    const resolved = posix.normalize(posix.join(fromDir, target));
    const context = match[1].substring(0, 60);
    links.push({ to: resolved, context });
  }
  return links;
}

export function generateLinksIndex(memoryDir, workspaceDir) {
  const config = loadConfig(workspaceDir);
  const excludePatterns = config.graph_exclude ?? [];
  const paths = walk(memoryDir).sort();
  const edges = [];

  for (const p of paths) {
    if (isExcluded(p, excludePatterns)) continue;
    const content = readFileSync(join(memoryDir, p), 'utf-8');
    const links = extractLinks(content, p);
    for (const link of links) {
      if (isExcluded(link.to, excludePatterns)) continue;
      edges.push({ from: p, to: link.to, context: link.context });
    }
  }

  const seen = new Set();
  const deduped = edges.filter(e => {
    const key = `${e.from}|${e.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rows = deduped.map(e => `| ${e.from} | ${e.to} | ${e.context} |`);
  const lines = [
    '---',
    'description: Cross-reference graph across memory files — auto-generated, do not edit',
    '---',
    '',
    '| From | To | Context |',
    '|------|----|---------|',
    ...rows,
    '',
  ];
  return lines.join('\n');
}

export function writeLinksIndex(memoryDir, workspaceDir) {
  const out = generateLinksIndex(memoryDir, workspaceDir);
  writeFileSync(join(memoryDir, 'LINKS.md'), out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const __filename = fileURLToPath(import.meta.url);
  const workspaceDir = join(dirname(__filename), '..', '..');
  const memoryDir = join(workspaceDir, 'user-data', 'memory');
  writeLinksIndex(memoryDir, workspaceDir);
  console.log('LINKS.md regenerated.');
}

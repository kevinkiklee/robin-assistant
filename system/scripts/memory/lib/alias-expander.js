// alias-expander.js — Pass 1 logic for densify-wiki.
// Derives alias candidates from H1 + filename, applies filter chain,
// writes atomic frontmatter mutations.

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { atomicWrite } from '../../jobs/lib/atomic.js';

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const H1_RE = /^#\s+(.+)$/m;
const ALIASES_RE = /^aliases:\s*\[([^\]]*)\]\s*$/m;
const TYPE_RE = /^type:\s*(\S+)\s*$/m;
const FM_BLOCK_RE = /^(---\n[\s\S]*?\n---\n?)/;

// Quote-aware splitter for inline YAML arrays. Mirrors splitInlineArray
// in wiki-graph/lib/build-entity-registry.js so aliases parse identically
// across the system. Treats commas inside double or single quotes as part
// of the value, and strips the surrounding quotes.
function splitInlineArray(inner) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ',') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function stripFrontmatter(body) {
  return body.replace(FRONTMATTER_RE, '');
}

function titleCase(s) {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function deriveCandidates({ body, filename }) {
  const candidates = new Set();
  const afterFm = stripFrontmatter(body);
  const h1Match = afterFm.match(H1_RE);
  if (h1Match) {
    const h1 = h1Match[1].trim();
    if (h1) candidates.add(h1);
  }
  const stem = filename.replace(/\.md$/, '');
  const fromFilename = titleCase(stem);
  if (fromFilename) candidates.add(fromFilename);
  return [...candidates];
}

function tokenCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function applyFilters(candidates, { existingAliases, inPassRegistry, stopList }) {
  const accepted = [];
  const rejected = [];
  const existingLower = new Set([...existingAliases].map(a => a.toLowerCase()));
  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (c.length < 3) {
      rejected.push({ candidate: c, reason: 'length-lt-3' });
      continue;
    }
    if (tokenCount(c) < 2) {
      rejected.push({ candidate: c, reason: 'single-token' });
      continue;
    }
    if (existingLower.has(lower)) {
      rejected.push({ candidate: c, reason: 'duplicate-self' });
      continue;
    }
    if (stopList.has(lower)) {
      rejected.push({ candidate: c, reason: 'stop-list' });
      continue;
    }
    if (inPassRegistry.has(c) || inPassRegistry.has(lower)) {
      rejected.push({ candidate: c, reason: `collision: ${inPassRegistry.get(c) ?? inPassRegistry.get(lower)}` });
      continue;
    }
    accepted.push(c);
  }
  return { accepted, rejected };
}

export const ENTITY_SHAPED_DIRS = [
  'profile/people/',
  'knowledge/service-providers/',
  'knowledge/projects/',
  'knowledge/locations/',
];

export function inEntityShapedDir(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return ENTITY_SHAPED_DIRS.some(d => norm.startsWith(d));
}

export function shouldFlipType({ relPath, currentType, hasAliases }) {
  if (!hasAliases) return false;
  if (!inEntityShapedDir(relPath)) return false;
  return currentType === 'topic';
}

function parseAliasArray(line) {
  if (!line) return [];
  return splitInlineArray(line);
}

function getFrontmatterField(body, re) {
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

function setAliasesAndType(body, newAliases, newType) {
  const fm = body.match(FM_BLOCK_RE);
  if (!fm) {
    const aliasesLine = `aliases: [${newAliases.join(', ')}]`;
    const typeLine = newType ? `\ntype: ${newType}` : '';
    return `---\n${aliasesLine}${typeLine}\n---\n${body}`;
  }
  let block = fm[1];
  const newAliasesLine = `aliases: [${newAliases.join(', ')}]`;
  block = ALIASES_RE.test(block)
    ? block.replace(ALIASES_RE, newAliasesLine)
    : block.replace(/\n---\n?$/, `\n${newAliasesLine}\n---\n`);
  if (newType) {
    block = TYPE_RE.test(block)
      ? block.replace(TYPE_RE, `type: ${newType}`)
      : block.replace(/\n---\n?$/, `\ntype: ${newType}\n---\n`);
  }
  return block + body.slice(fm[1].length);
}

function* walkMd(root, base = root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full, base);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield relative(base, full).split(/[\\/]/).join('/');
    }
  }
}

export async function expandAliases({ workspaceDir, stopList = new Set(), dryRun = false }) {
  const memoryRoot = join(workspaceDir, 'user-data', 'memory');
  const result = {
    filesModified: [],
    perFile: [],
    lint: { missingAliases: [] },
    summary: { aliasesAdded: 0, typeFlips: 0, rejections: [] },
  };
  const inPassRegistry = new Map();

  // First pass: build registry from existing aliases.
  for (const relPath of walkMd(memoryRoot)) {
    const body = readFileSync(join(memoryRoot, relPath), 'utf-8');
    const existing = parseAliasArray(getFrontmatterField(body, ALIASES_RE));
    for (const a of existing) {
      inPassRegistry.set(a, relPath);
      inPassRegistry.set(a.toLowerCase(), relPath);
    }
  }

  // Second pass: derive + filter + write per file.
  for (const relPath of walkMd(memoryRoot)) {
    const filePath = join(memoryRoot, relPath);
    const body = readFileSync(filePath, 'utf-8');
    const inEntityDir = inEntityShapedDir(relPath);
    const currentType = getFrontmatterField(body, TYPE_RE);
    const isTypeEntity = currentType === 'entity';
    const existingAliasesLine = getFrontmatterField(body, ALIASES_RE);
    const existingAliases = parseAliasArray(existingAliasesLine);

    if (!inEntityDir && !isTypeEntity && existingAliases.length === 0) continue;

    if (existingAliases.length === 0) {
      if (inEntityDir || isTypeEntity) {
        result.lint.missingAliases.push(relPath);
      }
      continue;
    }

    const filename = relPath.split('/').pop();
    const candidates = deriveCandidates({ body, filename });
    const filtered = applyFilters(candidates, {
      existingAliases: new Set(existingAliases),
      inPassRegistry,
      stopList,
    });
    const flipType = shouldFlipType({ relPath, currentType, hasAliases: existingAliases.length > 0 });

    if (filtered.accepted.length === 0 && !flipType) continue;

    const newAliases = [...existingAliases, ...filtered.accepted];
    for (const a of filtered.accepted) {
      inPassRegistry.set(a, relPath);
      inPassRegistry.set(a.toLowerCase(), relPath);
    }

    if (!dryRun) {
      const newBody = setAliasesAndType(body, newAliases, flipType ? 'entity' : null);
      atomicWrite(filePath, newBody);
    }

    result.filesModified.push(relPath);
    result.perFile.push({
      relPath,
      added: filtered.accepted,
      rejected: filtered.rejected,
      typeFlipped: flipType,
    });
    result.summary.aliasesAdded += filtered.accepted.length;
    if (flipType) result.summary.typeFlips += 1;
    result.summary.rejections.push(...filtered.rejected.map(r => ({ relPath, ...r })));
  }

  return result;
}

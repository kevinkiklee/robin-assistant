import { posix } from 'node:path';

const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function parseFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    frontmatter[kv[1]] = kv[2].trim();
  }
  return { frontmatter, body: m[2] };
}

export function stringifyFrontmatter(frontmatter, body) {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;
  const lines = keys.map(k => `${k}: ${frontmatter[k]}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function disambiguateSlug(slug, usedSet) {
  if (!usedSet.has(slug)) return slug;
  let n = 2;
  while (usedSet.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

export function countContentLines(content) {
  const { body } = parseFrontmatter(content);
  return body.split('\n').filter(line => line.trim().length > 0).length;
}

export function parseHeadings(content) {
  const lines = content.split('\n');
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const m = line.match(/^(#{2,6})\s+(.+?)\s*$/);
    if (m) {
      headings.push({ level: m[1].length, title: m[2], line: i + 1 });
    }
  }
  return headings;
}

export function sectionSizes(content, level = 2) {
  const lines = content.split('\n');
  const headings = parseHeadings(content).filter(h => h.level === level);
  const sizes = new Map();
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].line - 1;
    const end = (i + 1 < headings.length) ? headings[i + 1].line - 1 : lines.length;
    const slice = lines.slice(start, end).join('\n');
    sizes.set(headings[i].line, countContentLines(slice));
  }
  return sizes;
}

export function proposeDomainRoots(headings, sizes, opts = {}) {
  const childThreshold = opts.childThreshold ?? 50;
  // Only level-2 headings are candidates. Level-3+ are inherently children.
  const candidates = headings.filter(h => h.level === 2);
  return candidates.filter((h, i) => {
    if (i === 0) return true; // first level-2 is always a root
    const ownSize = sizes.get(h.line) ?? 0;
    return ownSize >= childThreshold;
  });
}

export function rewriteLinks(content, renames, fromPath) {
  // renames: Map of memory-relative-old-path → memory-relative-new-path
  // fromPath: memory-relative path of the file being processed
  // Both are interpreted relative to user-data/memory/ root.
  const fromDir = posix.dirname(fromPath);
  return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, target) => {
    if (target.match(/^[a-z][a-z0-9+.-]*:/i)) return match; // absolute URL
    if (target.startsWith('#')) return match;               // anchor
    const resolved = posix.normalize(posix.join(fromDir, target));
    if (renames.has(resolved)) {
      const newAbs = renames.get(resolved);
      let newRel = posix.relative(fromDir, newAbs);
      if (!newRel) newRel = `./${posix.basename(newAbs)}`;
      return `[${text}](${newRel})`;
    }
    return match;
  });
}

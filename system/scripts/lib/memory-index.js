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

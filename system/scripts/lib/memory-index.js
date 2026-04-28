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

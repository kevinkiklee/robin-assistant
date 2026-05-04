// External-skill loader. Parses SKILL.md frontmatter (custom YAML-lite,
// matching system/scripts/lib/protocol-frontmatter.js), validates skills,
// scans user-data/skills/external/, and maintains the INDEX.md +
// installed-skills.json manifest.
//
// External skills coexist with Robin's existing system/jobs/ protocols. This
// loader does NOT touch system/jobs/. See
// docs/superpowers/specs/2026-05-04-external-skill-compat-layer.md.

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseSkillFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter = {};
  const lines = m[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const [, key, raw] = kv;
    const trimmed = raw.trim();
    // Block-list form: `key:\n  - val\n  - val`
    if (trimmed === '' && i + 1 < lines.length && /^\s+- /.test(lines[i + 1])) {
      const arr = [];
      i++;
      while (i < lines.length && /^\s+- /.test(lines[i])) {
        const item = lines[i].replace(/^\s+- /, '').trim();
        const sm = item.match(/^["'](.*)["']$/);
        arr.push(sm ? sm[1] : item);
        i++;
      }
      frontmatter[key] = arr;
      continue;
    }
    frontmatter[key] = parseValue(trimmed);
    i++;
  }
  return { frontmatter, body: content.slice(m[0].length) };
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^"(.*)"$/.test(raw)) return raw.slice(1, -1);
  if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1);
  // Inline array: ["a", "b"]
  const arr = raw.match(/^\[(.*)\]$/);
  if (arr) {
    return arr[1]
      .split(',')
      .map((s) => {
        const t = s.trim();
        const sm = t.match(/^["'](.*)["']$/);
        return sm ? sm[1] : t;
      })
      .filter((s) => s.length > 0);
  }
  return raw;
}

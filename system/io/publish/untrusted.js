const UNTRUSTED_MARKERS = new Set(['untrusted', 'untrusted-mixed']);

export function shouldRefuseUntrusted(frontmatter, forceUntrusted) {
  if (forceUntrusted) return false;
  const trust = frontmatter?.trust;
  return typeof trust === 'string' && UNTRUSTED_MARKERS.has(trust);
}

const BLOCK_RE = /<!--\s*UNTRUSTED-START\s*-->[\s\S]*?(?:<!--\s*UNTRUSTED-END\s*-->|$)/g;

export function stripUntrustedBlocks(body) {
  if (!body?.includes('UNTRUSTED-START')) return { body, removed: 0 };
  let removed = 0;
  const cleaned = body.replace(BLOCK_RE, () => {
    removed += 1;
    return '';
  });
  return { body: cleaned.replace(/\n{3,}/g, '\n\n'), removed };
}

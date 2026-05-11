// domain.js — domain inference via token-overlap against the entity catalog.
// Spec §2.7. Weak hint, not authoritative: caller's explicit `domain` wins.

function tokensOf(s) {
  if (typeof s !== 'string') return [];
  return s
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1);
}

export function inferDomain(query, explicit, catalog, cfg) {
  if (explicit) {
    return { domain: String(explicit).toLowerCase(), source: 'explicit', telemetry: null };
  }
  if (!query) return { domain: null, source: 'none', telemetry: 'none' };

  const qTokens = new Set(tokensOf(String(query)));
  if (qTokens.size === 0) return { domain: null, source: 'none', telemetry: 'none' };

  const allowed = new Set(cfg.domain_entity_types ?? ['topic', 'project', 'library']);
  const matches = [];
  for (const ent of catalog ?? []) {
    if (!allowed.has(ent.type)) continue;
    const eTokens = tokensOf(String(ent.name ?? ''));
    if (eTokens.length === 0) continue;
    if (eTokens.some((t) => qTokens.has(t))) {
      matches.push(ent);
    }
  }

  if (matches.length === 0) return { domain: null, source: 'inferred', telemetry: 'none' };
  if (matches.length > 1) return { domain: null, source: 'inferred', telemetry: 'ambiguous' };
  return { domain: matches[0].name.toLowerCase(), source: 'inferred', telemetry: null };
}

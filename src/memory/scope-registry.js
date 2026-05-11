// scope-registry.js — single source of truth for scope policy.
//
// Replaces hardcoded SQL prefix lists (previously in store.js _surfaceSearch
// and step-scope-cleanup.js) and the unenforced `private` promise in the
// redesign spec.

export const SCOPE_REGISTRY = {
  // exact matches
  global: { lifetime: 'persistent', outbound: 'allow', ephemeral: false },
  private: { lifetime: 'persistent', outbound: 'block', ephemeral: false },

  // prefix matches (key ends with ':')
  'project:': {
    lifetime: 'persistent',
    outbound: 'allow',
    ephemeral: false,
    hierarchical: true,
  },
  'integration:': {
    lifetime: 'persistent',
    outbound: 'allow',
    ephemeral: false,
  },
  'session:': {
    lifetime: 'ephemeral',
    outbound: 'allow',
    ephemeral: true,
    ttl_days: 7,
  },
  'temp:': {
    lifetime: 'ephemeral',
    outbound: 'allow',
    ephemeral: true,
    ttl_days: 1,
  },
};

const PREFIX_KEYS = Object.keys(SCOPE_REGISTRY).filter((k) => k.endsWith(':'));
const SAFE_DEFAULT = Object.freeze({
  lifetime: 'persistent',
  outbound: 'allow',
  ephemeral: false,
});

export function policyFor(scope) {
  if (SCOPE_REGISTRY[scope]) return SCOPE_REGISTRY[scope];
  for (const p of PREFIX_KEYS) if (scope.startsWith(p)) return SCOPE_REGISTRY[p];
  return SAFE_DEFAULT;
}

export const isEphemeral = (s) => policyFor(s).ephemeral === true;
export const isHierarchical = (s) => policyFor(s).hierarchical === true;
export const isOutboundBlocked = (s) => policyFor(s).outbound === 'block';
export const ttlDays = (s) => policyFor(s).ttl_days ?? null;

export function validateScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error('scope: empty');
  }
  if (SCOPE_REGISTRY[scope]) return scope;
  for (const p of PREFIX_KEYS) if (scope.startsWith(p)) return scope;
  throw new Error(`scope: unknown pattern '${scope}'; register prefix in SCOPE_REGISTRY first`);
}

// Hierarchical prefix match. `query='project:robin'` matches itself plus any
// `project:robin/...` descendant; rejects sibling-prefix `project:robin-other`.
export function scopeMatches(query, target) {
  return target === query || target.startsWith(`${query}/`);
}

// SQL fragment for the default-recall persistent-scope filter. Computed once
// at module load; the registry is the source of truth.
export function persistentScopesSqlFilter() {
  const exact = Object.keys(SCOPE_REGISTRY).filter(
    (k) => !k.endsWith(':') && !SCOPE_REGISTRY[k].ephemeral,
  );
  const prefix = PREFIX_KEYS.filter((p) => !SCOPE_REGISTRY[p].ephemeral);
  const parts = [
    ...exact.map((s) => `scope = '${s}'`),
    ...prefix.map((p) => `string::starts_with(scope, '${p}')`),
  ];
  return `(${parts.join(' OR ')})`;
}

// Ephemeral entries iterated by step-scope-cleanup.
export function ephemeralEntries() {
  return Object.entries(SCOPE_REGISTRY).filter(([, p]) => p.ephemeral);
}

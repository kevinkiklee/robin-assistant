const ENTITY_TYPES = new Set(['person', 'place', 'project', 'topic', 'thing']);
const EDGE_TYPES = new Set([
  'mentions',
  'about',
  'precedes',
  'works_on',
  'participates_in',
  'co_occurs_with',
]);

export function validateBiographerOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'output must be an object' };
  if (!Array.isArray(o.entities)) return { ok: false, error: 'output.entities must be an array' };
  for (const e of o.entities) {
    if (typeof e?.name !== 'string' || e.name.length === 0) {
      return { ok: false, error: 'entity.name must be non-empty string' };
    }
    if (!ENTITY_TYPES.has(e.type)) {
      return { ok: false, error: `entity.type "${e.type}" not in vocabulary` };
    }
  }
  if (!Array.isArray(o.edges)) return { ok: false, error: 'output.edges must be an array' };
  const known = new Set(o.entities.map((e) => e.name));
  for (const ed of o.edges) {
    if (!EDGE_TYPES.has(ed?.type)) {
      return { ok: false, error: `edge.type "${ed?.type}" not in vocabulary` };
    }
    if (!known.has(ed.from)) {
      return { ok: false, error: `edge from "${ed.from}" references unknown entity` };
    }
    if (!known.has(ed.to)) {
      return { ok: false, error: `edge to "${ed.to}" references unknown entity` };
    }
  }
  if (!Array.isArray(o.about)) return { ok: false, error: 'output.about must be an array' };
  if (typeof o.episode_continues_previous !== 'boolean') {
    return { ok: false, error: 'episode_continues_previous must be boolean' };
  }
  return { ok: true };
}

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

/**
 * Validate a body object against a schema map.
 *
 * Schema map: { fieldName: 'type' | 'type?' }
 *   - Trailing `?` marks the field optional.
 *   - Unknown fields are rejected (strict).
 *   - Semantic checks (enum membership, regex, range) stay in the handler.
 *
 * Returns { ok: true, value } or { ok: false, errors: [{ path, message }] }.
 * The returned shape is internal — the HTTP envelope is built from it.
 */
export function validate(body, schema) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ path: '', message: 'body must be an object' }] };
  }
  const declaredKeys = new Set(Object.keys(schema));
  // Required + type checks
  for (const [key, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const baseType = optional ? spec.slice(0, -1) : spec;
    const check = TYPES[baseType];
    if (!check) {
      errors.push({ path: key, message: `schema error: unknown type '${spec}'` });
      continue;
    }
    if (!(key in body)) {
      if (!optional) errors.push({ path: key, message: 'required' });
      continue;
    }
    if (!check(body[key])) {
      errors.push({ path: key, message: `expected ${baseType}` });
    }
  }
  // Unknown-field check (strict)
  for (const key of Object.keys(body)) {
    if (!declaredKeys.has(key)) {
      errors.push({ path: key, message: 'unknown field' });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: body };
}

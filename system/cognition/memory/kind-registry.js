// kind-registry.js — MEMO_KIND_REGISTRY + ATTACHMENT_KIND_REGISTRY.
// Spec §5.2. The schema's `memos.kind` field is an OPEN string; this registry
// is the in-code source of truth for known kinds, their required fields, and
// any per-kind meta_schema hints. Unknown kinds are tolerated (open-enum policy)
// but lose validation; lenses route through these entries.

export const MEMO_KIND_REGISTRY = {
  knowledge: {
    required: ['content', 'derived_by'],
    dedup_by: 'content_hash',
    meta_schema: {},
  },
  habit: {
    required: ['content', 'derived_by'],
    meta_schema: {
      name: 'string!',
      description: 'string?',
      strength: 'number?',
    },
  },
  prediction: {
    required: ['content', 'derived_by'],
    meta_schema: {
      statement_kind: 'string!',
      expected_resolution_at: 'datetime?',
      resolved_at: 'datetime?',
      correct: 'boolean?',
      actual_outcome: 'string?',
    },
  },
  state_inference: {
    required: ['content', 'derived_by'],
    meta_schema: {
      dimension: 'string?',
      from_signal: 'array?',
    },
  },
  // Reserved `meta.dimension` values for `reasoning` memos:
  //   - 'recall_failures' — D2 meta-cognition (weekly recall-failure summaries).
  //   - 'calibration'     — D3 meta-cognition-calibration (post-revision).
  // New dimensions extend this comment; the field itself is open-enum.
  reasoning: {
    required: ['content', 'derived_by'],
    meta_schema: {
      // Legacy keys (pre-D2 producers may write these):
      session_id: 'string?',
      step: 'string?',
      // D2 + D3 meta-cognition writers (coordinated; reserved meta.dimension
      // values are 'recall_failures' (D2-owned) and 'calibration' (D3-owned)):
      dimension: 'string?',
      from_signal: 'string?', // string for reasoning kind (D1's state_inference uses 'array?')
      domain: 'string?', // D3
      brier: 'number?', // D3
      drift: 'number?', // D3
      accuracy: 'number?', // D3
      mean_confidence: 'number?', // D3
      samples: 'number?', // D3
      trend: 'string?', // D3 — 'new' | 'improving' | 'flat' | 'worsening'
      period: 'string?', // D2
      signal_count: 'number?', // D2
      week_starting: 'string?', // D2 + D3 — ISO date of Sunday 00:00 local
      clusters: 'number?', // D2
      recall_log_ids: 'array?', // D2 — lineage (string IDs, NOT derived_from edges)
    },
  },
  session_outcome: {
    required: ['content', 'derived_by'],
    meta_schema: {
      session_id: 'string!',
      success: 'boolean?',
    },
  },
};

const ATTACHMENT_KIND_REGISTRY = {
  file: { required: ['ref'], optional: ['hash', 'mime', 'size'] },
  image: {
    required: ['ref'],
    optional: ['hash', 'mime', 'size', 'alt', 'width', 'height'],
  },
  audio: { required: ['ref'], optional: ['hash', 'mime', 'size', 'duration_ms'] },
  video: { required: ['ref'], optional: ['hash', 'mime', 'size', 'duration_ms'] },
  url: { required: ['ref'], optional: ['title', 'description'] },
};

/**
 * Validate a memo payload against its kind's registry entry.
 * Returns `{ ok: true }` on pass OR for unknown kinds (open-enum policy).
 * Returns `{ ok: false, errors: [...] }` when a known kind's required fields
 * are missing or meta_schema is violated.
 */
export function validateMemoKind(kind, payload) {
  const spec = MEMO_KIND_REGISTRY[kind];
  if (!spec) return { ok: true }; // unknown kind: tolerated, advisory only
  const errors = [];
  for (const field of spec.required ?? []) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(`required field missing: ${field}`);
    }
  }
  if (spec.meta_schema) {
    const meta = payload.meta ?? {};
    for (const [key, type] of Object.entries(spec.meta_schema)) {
      const required = type.endsWith('!');
      const baseType = type.replace(/[!?]$/, '');
      const v = meta[key];
      if (v === undefined || v === null) {
        if (required) errors.push(`meta.${key} required (${baseType})`);
        continue;
      }
      if (!matchesType(v, baseType)) {
        errors.push(`meta.${key} expected ${baseType}, got ${typeof v}`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateAttachment(att) {
  if (!att || typeof att !== 'object') {
    return { ok: false, errors: ['attachment must be an object'] };
  }
  const spec = ATTACHMENT_KIND_REGISTRY[att.kind];
  if (!spec) return { ok: true }; // unknown attachment kind: tolerated
  const errors = [];
  for (const field of spec.required ?? []) {
    if (att[field] === undefined || att[field] === null || att[field] === '') {
      errors.push(`required field missing: ${field}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function matchesType(v, type) {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && !Number.isNaN(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && !Array.isArray(v) && v !== null;
    case 'datetime':
      return v instanceof Date || typeof v === 'string';
    default:
      return true;
  }
}

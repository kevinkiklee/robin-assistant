// output.js — validator for the LLM JSON response in D2.
// Spec §3.3. Returns { ok: true, parsed } on success (with values clamped /
// normalised in-place), or { ok: false, errors } on shape violations.
// Rule confidences outside [0,1] are clamped — the LLM occasionally returns
// 1.2 etc and rejecting the whole response loses a week's signal for no gain.

/**
 * @param {unknown} parsed   Already-JSON.parsed response from the LLM.
 * @param {{ max_rules_per_run:number }} _config (kept for forward compatibility)
 * @returns {{ ok:true, parsed: {
 *   narrative:string,
 *   clusters: Array<{
 *     cluster_id:string,
 *     error_pattern:string,
 *     suggested_rules:string[],
 *     rule_confidence:number[],
 *   }>
 * } } | { ok:false, errors:string[] }}
 */
export function validateMetaCognitionOutput(parsed, _config) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['response not an object'] };
  }
  if (typeof parsed.narrative !== 'string' || parsed.narrative.length === 0) {
    errors.push('narrative missing or not a non-empty string');
  }
  if (!Array.isArray(parsed.clusters)) {
    errors.push('clusters must be an array');
  } else {
    parsed.clusters.forEach((c, i) => {
      if (!c || typeof c !== 'object') {
        errors.push(`clusters[${i}] not an object`);
        return;
      }
      if (typeof c.cluster_id !== 'string') errors.push(`clusters[${i}].cluster_id missing`);
      if (typeof c.error_pattern !== 'string') errors.push(`clusters[${i}].error_pattern missing`);
      if (!Array.isArray(c.suggested_rules))
        errors.push(`clusters[${i}].suggested_rules must be array`);
      if (!Array.isArray(c.rule_confidence))
        errors.push(`clusters[${i}].rule_confidence must be array`);
      if (Array.isArray(c.suggested_rules) && Array.isArray(c.rule_confidence)) {
        if (c.suggested_rules.length !== c.rule_confidence.length) {
          errors.push(
            `clusters[${i}].rule_confidence length (${c.rule_confidence.length}) != suggested_rules length (${c.suggested_rules.length})`,
          );
        } else {
          // Clamp confidences.
          c.rule_confidence = c.rule_confidence.map((v) => clamp01(Number(v)));
        }
        // Drop non-string rules silently? No — validator is structural; leave
        // type-coerce to the writer caller.
        c.suggested_rules = c.suggested_rules.map((s) => String(s ?? ''));
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, parsed };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

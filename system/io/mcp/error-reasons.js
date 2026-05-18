// Enumerated MCP tool error reasons. Every MCP tool's failure response
// should use either an enum value (preferred) or a string aliased here
// (legacy compat).
//
// New code: use ERROR_REASONS.<NAME> directly.
// Legacy strings already returned in the wild: map to enum via
// REASON_ALIASES so consumers (agent prompts, scripts) keep matching.

export const ERROR_REASONS = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  OUTBOUND_BLOCKED: 'outbound_blocked',
  REQUIRES_PERMISSION: 'requires_permission',
  INVALID_ARGS: 'invalid_args',
  NOT_FOUND: 'not_found',
  IN_FLIGHT: 'in_flight',
  UPSTREAM_FAILED: 'upstream_failed',
  DB_ERROR: 'db_error',
  TIMEOUT: 'timeout',
  UNAUTHORIZED: 'unauthorized',
  CONFLICT: 'conflict',
  NOT_IMPLEMENTED: 'not_implemented',
});

// Aliases: legacy string → canonical enum value. Pre-existing strings
// observed in the codebase that don't exactly match an enum value get
// canonicalized here so MCP consumers can use either form.
export const REASON_ALIASES = Object.freeze({
  // RATE_LIMITED
  'rate-limited': ERROR_REASONS.RATE_LIMITED,
  rate_limit_exceeded: ERROR_REASONS.RATE_LIMITED,
  // REQUIRES_PERMISSION
  'permission-required': ERROR_REASONS.REQUIRES_PERMISSION,
  permission_required: ERROR_REASONS.REQUIRES_PERMISSION,
  'requires-permission': ERROR_REASONS.REQUIRES_PERMISSION,
  // INVALID_ARGS (legacy validation strings observed in tree)
  bad_args: ERROR_REASONS.INVALID_ARGS,
  'invalid-args': ERROR_REASONS.INVALID_ARGS,
  missing_arg: ERROR_REASONS.INVALID_ARGS,
  ambiguous_input: ERROR_REASONS.INVALID_ARGS,
  exactly_one_id_required: ERROR_REASONS.INVALID_ARGS,
  invalid_class: ERROR_REASONS.INVALID_ARGS,
  invalid_confidence: ERROR_REASONS.INVALID_ARGS,
  invalid_state: ERROR_REASONS.INVALID_ARGS,
  invalid_verdict: ERROR_REASONS.INVALID_ARGS,
  invalid_task_type: ERROR_REASONS.INVALID_ARGS,
  invalid_insight_id: ERROR_REASONS.INVALID_ARGS,
  invalid_frontmatter: ERROR_REASONS.INVALID_ARGS,
  invalid_profile_name: ERROR_REASONS.INVALID_ARGS,
  // UNAUTHORIZED (missing creds / scope)
  'missing-secret': ERROR_REASONS.UNAUTHORIZED,
  missing_secret: ERROR_REASONS.UNAUTHORIZED,
  // NOT_FOUND
  insight_not_found: ERROR_REASONS.NOT_FOUND,
  job_not_found: ERROR_REASONS.NOT_FOUND,
  unknown_integration: ERROR_REASONS.NOT_FOUND,
  record_missing: ERROR_REASONS.NOT_FOUND,
  // UPSTREAM_FAILED (network / vendor / extraction)
  fetch_failed: ERROR_REASONS.UPSTREAM_FAILED,
  extraction_failed: ERROR_REASONS.UPSTREAM_FAILED,
  sync_error: ERROR_REASONS.UPSTREAM_FAILED,
  llm_error: ERROR_REASONS.UPSTREAM_FAILED,
  llm_parse_error: ERROR_REASONS.UPSTREAM_FAILED,
  osascript_failed: ERROR_REASONS.UPSTREAM_FAILED,
  playwright_error: ERROR_REASONS.UPSTREAM_FAILED,
  // OUTBOUND_BLOCKED (policy refusals on outbound writes)
  untrusted_quote: ERROR_REASONS.OUTBOUND_BLOCKED,
  url_blocked: ERROR_REASONS.OUTBOUND_BLOCKED,
  private_scope_contamination: ERROR_REASONS.OUTBOUND_BLOCKED,
});

export function canonicalize(reason) {
  if (Object.values(ERROR_REASONS).includes(reason)) return reason;
  return REASON_ALIASES[reason] ?? reason;
}

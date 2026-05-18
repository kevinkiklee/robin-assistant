import test from 'node:test';
import assert from 'node:assert';
import { ERROR_REASONS, REASON_ALIASES, canonicalize } from '../../io/mcp/error-reasons.js';

test('ERROR_REASONS has expected canonical values', () => {
  assert.strictEqual(ERROR_REASONS.RATE_LIMITED, 'rate_limited');
  assert.strictEqual(ERROR_REASONS.OUTBOUND_BLOCKED, 'outbound_blocked');
  assert.strictEqual(ERROR_REASONS.REQUIRES_PERMISSION, 'requires_permission');
  assert.strictEqual(ERROR_REASONS.DB_ERROR, 'db_error');
});

test('canonicalize passes through enum values unchanged', () => {
  assert.strictEqual(canonicalize('rate_limited'), 'rate_limited');
  assert.strictEqual(canonicalize('db_error'), 'db_error');
});

test('canonicalize maps legacy strings to enum values', () => {
  assert.strictEqual(canonicalize('rate-limited'), 'rate_limited');
  assert.strictEqual(canonicalize('permission-required'), 'requires_permission');
  assert.strictEqual(canonicalize('bad_args'), 'invalid_args');
  // Aliases sourced from the codebase inventory
  assert.strictEqual(canonicalize('insight_not_found'), 'not_found');
  assert.strictEqual(canonicalize('fetch_failed'), 'upstream_failed');
  assert.strictEqual(canonicalize('untrusted_quote'), 'outbound_blocked');
});

test('canonicalize returns input unchanged when no alias exists', () => {
  assert.strictEqual(canonicalize('totally_new_reason'), 'totally_new_reason');
  // Job-internal sentinel strings are intentionally not aliased — they are
  // operational state, not MCP failure codes — and should pass through.
  assert.strictEqual(canonicalize('already_biographed'), 'already_biographed');
  // REASON_ALIASES is frozen
  assert.throws(() => { REASON_ALIASES['x'] = 'y'; });
});

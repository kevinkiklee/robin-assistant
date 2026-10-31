/**
 * Redaction for `integration_status`, whose per-integration branch returns
 * every `integration_state` row for the named integration — OAuth access and
 * refresh tokens included, in plaintext. That output goes straight into a
 * model transcript, so a routine "why is whoop failing?" lookup would print
 * live credentials.
 *
 * The row itself is kept: the key name, the integration and `updated_at` are
 * the actual diagnostics (is it set, when did it last rotate), and none of
 * them are secret. Only the value is replaced, with its length, so "is it
 * present" and "did it change" remain answerable without exposing it.
 */

/** Keys whose VALUE is a credential. Matched case-insensitively as a substring. */
const SECRET_KEY =
  /(token|secret|password|passwd|credential|bearer|cookie|api[_-]?key|private[_-]?key|access[_-]?key)/i;

/**
 * Suffixes that mark a key as metadata ABOUT a credential rather than the
 * credential itself — `whoop_access_token_expiry` contains "token" but holds a
 * timestamp, and it is precisely what you open this tool to read when an OAuth
 * grant misbehaves. Checked first, so it wins over {@link SECRET_KEY}.
 */
const SECRET_METADATA = /(expiry|expires(_at)?|_at|_count|_state|_status)$/i;

export interface IntegrationStateRow {
  integration_name?: string;
  key?: string;
  value?: unknown;
  updated_at?: string;
}

/** True when this key's value must not be printed. */
export function isSecretKey(key: string): boolean {
  if (SECRET_METADATA.test(key)) return false;
  return SECRET_KEY.test(key);
}

/**
 * Returns a copy of `rows` with credential values replaced. Never mutates the
 * input — the caller's rows come straight from a prepared statement and may be
 * reused.
 */
export function redactIntegrationStateRows(rows: IntegrationStateRow[]): IntegrationStateRow[] {
  return rows.map((row) => {
    const key = typeof row.key === 'string' ? row.key : '';
    if (!isSecretKey(key)) return { ...row };
    const length = typeof row.value === 'string' ? row.value.length : 0;
    return { ...row, value: `[redacted — ${length} chars]` };
  });
}

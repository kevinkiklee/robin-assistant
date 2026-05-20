import { INBOUND_EXTRA_PATTERNS, PII_PATTERNS, SECRET_PATTERNS } from './patterns.ts';

export type DiscretionDecision = { ok: true } | { ok: false; reason: string };

/**
 * Outbound discretion check. Applied immediately before a write leaves the
 * trust boundary (Discord reply, spotify_write, publish, etc.).
 *
 * Refuses on:
 *   - PII shapes (credit card with Luhn, SSN, SIN)
 *   - Credential shapes (OpenAI/Anthropic keys, GitHub tokens, AWS access keys,
 *     Google API keys, Slack tokens, Stripe keys, env-var assignments)
 *
 * Origin allowlist (`trustedOrigins`) shortcuts: when the destination is the
 * user themselves (their own DM, their personal server), echoing untrusted
 * inputs back is the entire point of the surface — PII + secret guards still
 * apply, but the verbatim-quote layer (future) is skipped. Match is exact OR
 * by `:`-bounded prefix, so `discord:guild:G1` covers thread/channel children.
 */
export interface CheckOutboundInput {
  text: string;
  destination?: string;
  origin?: string | null;
  trustedOrigins?: string[];
}

function isTrustedOrigin(origin: string | null | undefined, trustedOrigins?: string[]): boolean {
  if (!origin || !Array.isArray(trustedOrigins) || trustedOrigins.length === 0) return false;
  for (const allowed of trustedOrigins) {
    if (!allowed) continue;
    if (origin === allowed) return true;
    if (origin.startsWith(`${allowed}:`)) return true;
  }
  return false;
}

export function checkOutbound(input: CheckOutboundInput): DiscretionDecision {
  const text = input.text ?? '';
  for (const p of PII_PATTERNS) {
    const m = p.regex.exec(text);
    if (m && (!p.mask || p.mask(m[0]))) return { ok: false, reason: `pii:${p.name}` };
  }
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(text)) return { ok: false, reason: `secret:${p.name}` };
  }
  // Origin allowlist shortcut: skip verbatim-quote layer (not yet implemented
  // in v3 — would require a sub-string scan against captured untrusted events).
  // PII + secret guards above always apply regardless of origin.
  if (isTrustedOrigin(input.origin ?? input.destination ?? null, input.trustedOrigins)) {
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Inbound discretion check. Applied inside MCP memory-write handlers
 * (remember, record_correction, etc.) before persisting user-supplied content.
 *
 * Inbound is intentionally narrower than outbound: medical/financial *history*
 * is fine in memory ("card ending in 4242 is preferred"); but raw credentials
 * never are. Catches credential shapes + PEM blocks + JWTs + password assignments.
 */
export function checkInbound(text: string): DiscretionDecision {
  if (typeof text !== 'string' || text.length === 0) return { ok: true };
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(text)) return { ok: false, reason: `secret:${p.name}` };
  }
  for (const p of INBOUND_EXTRA_PATTERNS) {
    if (p.regex.test(text)) return { ok: false, reason: `secret:${p.name}` };
  }
  return { ok: true };
}

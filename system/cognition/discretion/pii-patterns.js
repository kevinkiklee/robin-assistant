// Inbound PII / secret patterns — applied inside MCP memory-write handlers
// (recordEvent, remember, record_correction, update_rule).
//
// Inbound is intentionally NARROWER than outbound (`src/outbound/patterns.js`).
// Rationale (per Phase 4a §5.B): medical/financial history can legitimately
// *enter* memory (e.g. "I had surgery in 2024", "card ending in 4242 is my
// preferred"); the inbound list catches only credential / secret shapes that
// should never be persisted regardless of context.
//
// Outbound separately blocks SSN / credit cards / SIN against egress writers.

import { SECRET_PATTERNS } from '../../io/outbound/patterns.js';

// Re-use the canonical secret list from the outbound module so they cannot
// drift apart (DRY). Inbound adds a few more credential-shape rules.
export const INBOUND_DENY_PATTERNS = [
  ...SECRET_PATTERNS,
  {
    name: 'private_key_pem',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'password_assignment',
    regex: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}["']?/i,
  },
];

// First-match-wins. Returns {ok:true} on clean text, otherwise
// {ok:false, reason:'secret:<name>'}.
export function checkInbound(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: true };
  for (const p of INBOUND_DENY_PATTERNS) {
    if (p.regex.test(text)) {
      return { ok: false, reason: `secret:${p.name}` };
    }
  }
  return { ok: true };
}

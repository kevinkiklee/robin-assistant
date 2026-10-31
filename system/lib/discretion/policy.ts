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

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object') {
    // Keys too: a payload record can carry a secret as its key.
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
}

/** `checkInbound` over every string anywhere in a tool's arguments (nested payloads too). */
export function checkInboundArgs(args: unknown): DiscretionDecision {
  const strings: string[] = [];
  collectStrings(args, strings);
  return checkInbound(strings.join('\n'));
}

/**
 * Event kinds recall, auto-recall and the linkers treat as first-party (curated
 * beliefs and knowledge, captured sessions, corrections, integration records). A
 * caller-chosen kind on a generic write tool must not land in one of these: injected
 * text would come back as trusted memory. Beliefs go through `believe`, corrections
 * through `record_correction`.
 */
/**
 * Kinds read tools treat as first-party (returned unfenced). Every one is reserved
 * below, so a write tool's caller can't mint one. Notes from `remember` are NOT on
 * this list: any session's model can call it, a manipulated one included.
 */
export const TRUSTED_KIND_PREFIXES: readonly string[] = [
  'belief.',
  'knowledge.',
  'session.',
  'conversation.',
  'correction',
];

const RESERVED_KIND_PREFIXES: readonly string[] = [
  ...TRUSTED_KIND_PREFIXES,
  'prediction',
  'recommendation',
  'behavior.',
  'integration.',
];

/** The reserved prefix `kind` falls under, or null when a generic write may use it. */
export function reservedMemoryKind(kind: string | undefined): string | null {
  if (!kind) return null;
  const k = kind.trim().toLowerCase();
  return RESERVED_KIND_PREFIXES.find((p) => k.startsWith(p)) ?? null;
}

/** The MCP refusal for a write whose `kind` is reserved. */
export function reservedKindRefusal(kind: string): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Refused: kind '${kind}' is reserved for first-party memory. Use a neutral kind (e.g. memory.remember, research.brief); beliefs go through believe, corrections through record_correction.`,
      },
    ],
  };
}

/** The MCP refusal for a memory write that carried a credential — never echoes it. */
export function inboundRefusal(reason: string): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Refused: the input contains a credential (${reason}). Memory never stores secrets — remove it and retry.`,
      },
    ],
  };
}

/**
 * Replace every credential-shaped run in `text` with `[REDACTED:<pattern>]`.
 * For text Robin STORES (captured sessions), where refusing isn't an option:
 * an Anthropic OAuth token pasted into a session sat in memory, and from there
 * reached the embedding API (found 2026-10-03).
 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const p of [...SECRET_PATTERNS, ...INBOUND_EXTRA_PATTERNS]) {
    const global = new RegExp(
      p.regex.source,
      p.regex.flags.includes('g') ? p.regex.flags : `${p.regex.flags}g`,
    );
    out = out.replace(global, () => {
      redacted++;
      return `[REDACTED:${p.name}]`;
    });
  }
  return { text: out, redacted };
}

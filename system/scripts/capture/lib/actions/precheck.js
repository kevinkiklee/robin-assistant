// Deterministic hard-rule precheck. Always runs before any AUTO emission.
//
// Returns: { ok, reason, fallback }
//   ok=true              -> action proceeds in its declared state
//   ok=false fallback=ASK   -> downgrade AUTO to ASK; user confirms
//   ok=false fallback=BLOCK -> refuse the action entirely; surface refusal
//
// This module is the ONLY place hard-rules live for the action machine.
// Capture rules privacy block remains the source of truth for memory writes;
// this layer enforces the same patterns at action-emission time.

// --- Privacy patterns (BLOCK) ---

// Full SSN (9 digits with optional dashes). Reject "123-45-6789" but allow "1111".
const SSN = /\b\d{3}-?\d{2}-?\d{4}\b/;
// SIN (Canadian): 9 digits in 3-3-3 grouping; same shape detection.
const SIN = /\b\d{3}\s?\d{3}\s?\d{3}\b/;
// Card (PAN): 13–19 digits, optionally separated by dashes or spaces.
const PAN = /\b(?:\d[\s-]?){13,19}\b/;
// IBAN: country code (2 letters) + check digits (2) + 11–30 alphanumerics.
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
// API-key-ish: long strings with sk-/ghp_/etc. prefixes (allow hyphens in tail for sk-proj-... style).
const API_KEY = /\b(?:sk|pk|ghp|gho|ghs|ghu|ghr|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9-]{20,}\b/;
// AWS secret key (40 base64-ish chars after a label).
const AWS_SECRET = /\b(?:aws_secret_access_key|secret_key)\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}['"]?/i;
// URL with embedded credentials.
const URL_CREDS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;

// --- Threshold patterns (ASK) ---

// Dollar amounts > $1000. Match "$5,000", "$5000", "$5000.00", "USD 5000".
function dollarOver1k(text) {
  const matches = text.match(/(?:\$|USD\s?)\s?([\d,]+(?:\.\d+)?)/gi);
  if (!matches) return false;
  for (const m of matches) {
    const num = parseFloat(m.replace(/[^\d.]/g, ''));
    if (num > 1000) return true;
  }
  return false;
}

// Health / legal / stress-test keywords (ASK only — these need user judgment).
const HEALTH_LEGAL = new RegExp(
  [
    'diagnosis', 'medication', 'dosage', 'mg/kg', 'epinephrine',
    'subpoena', 'lawsuit', 'litigation', 'plea', 'indictment',
    'will\\s+and\\s+testament', 'beneficiary',
  ].join('|'),
  'i',
);

function paramsToText(params) {
  if (params == null) return '';
  if (typeof params === 'string') return params;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

export function precheckAction({ class: cls, params, policies }) {
  // 1. Explicit NEVER in policies wins, regardless of other context.
  if (policies?.never?.includes(cls)) {
    return { ok: false, reason: 'class explicitly marked NEVER in policies.md', fallback: 'BLOCK' };
  }

  const text = paramsToText(params);

  // 2. Privacy patterns → BLOCK.
  if (SSN.test(text)) return { ok: false, reason: 'privacy: SSN pattern in params', fallback: 'BLOCK' };
  if (SIN.test(text)) return { ok: false, reason: 'privacy: SIN pattern in params', fallback: 'BLOCK' };
  if (PAN.test(text)) return { ok: false, reason: 'privacy: full card number in params', fallback: 'BLOCK' };
  if (IBAN.test(text)) return { ok: false, reason: 'privacy: IBAN pattern in params', fallback: 'BLOCK' };
  if (API_KEY.test(text) || AWS_SECRET.test(text))
    return { ok: false, reason: 'privacy: credential/secret shape in params', fallback: 'BLOCK' };
  if (URL_CREDS.test(text))
    return { ok: false, reason: 'privacy: URL with embedded credentials in params', fallback: 'BLOCK' };

  // 3. Threshold/keyword patterns → ASK.
  if (dollarOver1k(text)) return { ok: false, reason: 'dollar threshold >$1000', fallback: 'ASK' };
  if (HEALTH_LEGAL.test(text))
    return { ok: false, reason: 'health/legal/stress-test keyword', fallback: 'ASK' };

  return { ok: true, reason: null, fallback: null };
}

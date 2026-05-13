// Patterns for PII and secrets. Mask functions return true if the matched
// substring should be considered a real hit (e.g. Luhn-valid credit cards).

export const PII_PATTERNS = [
  {
    // Anchored 13-19-digit numeric pattern with optional single space/dash
    // between digit groups. The previous `(?:\d[ -]*?){13,19}` with a nested
    // quantifier was ReDOS-prone on long pathological inputs; this form has
    // bounded backtracking and still matches all common card layouts
    // (4444-3333-2222-1111, 4444 3333 2222 1111, 4444333322221111, plus
    // 13-/15-/16-/19-digit variants). Luhn mask still gates final hit.
    name: 'credit_card',
    regex: /\b\d(?:[ -]?\d){12,18}\b/,
    mask: (s) => luhnCheck(s.replace(/[^0-9]/g, '')),
  },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/, mask: () => true },
  { name: 'sin', regex: /\b\d{3}-\d{3}-\d{3}\b/, mask: () => true },
];

export const SECRET_PATTERNS = [
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9-_]{32,}\b/ },
  // GitHub tokens: classic PAT (ghp_), OAuth app (gho_), user-to-server (ghu_),
  // server-to-server (ghs_), refresh (ghr_). All 36+ chars after the prefix.
  { name: 'github_token', regex: /\bgh[ouprs]_[A-Za-z0-9]{36,}\b/ },
  // Fine-grained PAT — distinct prefix, longer body. Matches "github_pat_"
  // followed by 22 chars + underscore + 59 chars (current spec).
  { name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  // Google / Gemini / GCP user API keys are exactly AIza + 35 unreserved
  // base64-url chars. Robin uses GEMINI_API_KEY explicitly, so this pattern
  // catches the most common accidental paste-in of "remember my key is …".
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Slack legacy tokens (xoxb/xoxa/xoxp/xoxe — workspace, app, user, refresh).
  // Bot tokens land here when a user pastes a Slack integration URL; chat
  // content tends not to false-match.
  { name: 'slack_token', regex: /\bxox[abope]-[0-9A-Za-z-]{10,}\b/ },
  // Stripe live + test secret keys (sk_) and restricted keys (rk_). Test
  // keys are still credentials and should not leak outbound.
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: 'env_secret_value', regex: /\b(?:[A-Z_]{4,})\s*=\s*[A-Za-z0-9+/]{20,}\b/ },
];

function luhnCheck(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

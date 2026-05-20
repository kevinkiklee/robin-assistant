// PII + credential regex tables for inbound + outbound discretion checks.
// Each PII pattern has an optional `mask(matched)` that returns true if the
// match should be considered a real hit (Luhn for credit cards).

export interface PiiPattern {
  name: string;
  regex: RegExp;
  mask?: (matched: string) => boolean;
}

export interface SecretPattern {
  name: string;
  regex: RegExp;
}

function luhnCheck(digits: string): boolean {
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

export const PII_PATTERNS: PiiPattern[] = [
  // 13–19-digit numeric strings with optional separators. Luhn mask gates final
  // hit so phone numbers and random IDs don't false-positive.
  {
    name: 'credit_card',
    regex: /\b\d(?:[ -]?\d){12,18}\b/,
    mask: (s) => luhnCheck(s.replace(/[^0-9]/g, '')),
  },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/, mask: () => true },
  { name: 'sin', regex: /\b\d{3}-\d{3}-\d{3}\b/, mask: () => true },
];

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9-_]{32,}\b/ },
  // GitHub: classic (ghp_), oauth-app (gho_), user-to-server (ghu_),
  // server-to-server (ghs_), refresh (ghr_). All ≥ 36 chars after prefix.
  { name: 'github_token', regex: /\bgh[ouprs]_[A-Za-z0-9]{36,}\b/ },
  { name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  // Google/Gemini/GCP API keys: AIza + 35 unreserved base64url chars.
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Slack legacy bot/app/user/refresh tokens.
  { name: 'slack_token', regex: /\bxox[abope]-[0-9A-Za-z-]{10,}\b/ },
  // Stripe live + test secret and restricted keys.
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  // Coarse "ENV_VAR=value" shape — catches accidental .env paste.
  { name: 'env_secret_value', regex: /\b(?:[A-Z_]{4,})\s*=\s*[A-Za-z0-9+/]{20,}\b/ },
];

// Inbound-only extras (PEM keys, JWTs, password assignments).
export const INBOUND_EXTRA_PATTERNS: SecretPattern[] = [
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

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

// Base64 of an ASCII decimal string, 4 chars per 3 digits: every group is
// [MNO][DTjz][AEIMQUYcgk][w-z0-5]; a 1- or 2-digit tail (unpadded) is
// [MNO][AQgw] or [MNO][DTjz][AEIMQUYcgk]. A Discord bot token's first part is the
// base64 of the bot's 17–20-digit user id, so this pins it far tighter than
// "24–26 base64url chars" and keeps dotted hostnames out.
const B64_DIGITS =
  '(?:[MNO][DTjz][AEIMQUYcgk][w-z0-5]){5,6}(?:[MNO][DTjz][AEIMQUYcgk]|[MNO][AQgw])?';

// Key names that mark the value as a credential: `*token`, `*secret`,
// `api_key`/`apiKey`, `access_key`, `private_key`, `password`. Must END the
// key, so `tokenizer`, `max_tokens` and `cache_key` don't qualify.
const CREDENTIAL_KEY =
  '(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d)';

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  // OpenAI project / service-account / admin keys carry `_` and `-` in the body.
  { name: 'openai_scoped_key', regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9-_]{32,}\b/ },
  // GitHub: classic (ghp_), oauth-app (gho_), user-to-server (ghu_),
  // server-to-server (ghs_), refresh (ghr_). All ≥ 36 chars after prefix.
  { name: 'github_token', regex: /\bgh[ouprs]_[A-Za-z0-9]{36,}\b/ },
  { name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'gitlab_pat', regex: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  // Google/Gemini/GCP API keys: AIza + 35 unreserved base64url chars.
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Google OAuth access (ya29.) and refresh (1//0) tokens. Standard base64
  // uses `/`, so the refresh shape must not sit inside a base64 run.
  { name: 'google_oauth_token', regex: /\bya29\.[A-Za-z0-9_-]{20,}/ },
  { name: 'google_refresh_token', regex: /(?<![A-Za-z0-9+/])1\/\/0[A-Za-z0-9_-]{20,}/ },
  // Discord bot token: base64(user id) . 6-char timestamp . 27–38-char HMAC.
  {
    name: 'discord_bot_token',
    regex: new RegExp(
      `(?<![A-Za-z0-9_-])${B64_DIGITS}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,38}(?![A-Za-z0-9_-])`,
    ),
  },
  // Slack legacy bot/app/user/refresh tokens.
  { name: 'slack_token', regex: /\bxox[abope]-[0-9A-Za-z-]{10,}\b/ },
  // Stripe live + test secret and restricted keys.
  { name: 'stripe_key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  // Vercel Blob read-write tokens (BLOB_READ_WRITE_TOKEN).
  { name: 'vercel_blob_token', regex: /\bvercel_blob_rw_[A-Za-z0-9_]{20,}\b/ },
  { name: 'linear_key', regex: /\blin_api_[A-Za-z0-9]{30,}\b/ },
  { name: 'huggingface_token', regex: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: 'npm_token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'supabase_token', regex: /\bsbp_[a-f0-9]{40}\b/ },
  { name: 'notion_token', regex: /\bntn_[A-Za-z0-9]{40,}\b/ },
  // Coarse "ENV_VAR=value" shape — catches accidental .env paste. Unquoted
  // only: `const SLUG_ALPHABET = 'abc…'` is code (quoted values are caught under
  // credential names below). A value with `-`/`_` (base64url) must mix upper,
  // lower and digits, so kebab-case branch names and UUIDs stay clean.
  {
    name: 'env_secret_value',
    regex:
      /\b[A-Z_][A-Z0-9_]{3,}\s*=\s*(?:[A-Za-z0-9+/]{20,}\b|(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{20,})/,
  },
  // Assignment under a credential-named key, any case: env (`API_TOKEN="…"`),
  // JSON (`"api_key": "…"`), JS (`clientSecret: '…'`). The value must carry a
  // digit, which keeps `token = process.env.X`-style code references out.
  {
    name: 'credential_assignment',
    regex: new RegExp(
      `${CREDENTIAL_KEY}["']?\\s*[:=]\\s*["']?(?=[A-Za-z0-9+/_.=-]*\\d)[A-Za-z0-9+/_.=-]{20,}`,
      'i',
    ),
  },
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
    regex: /\b(?:password|passwd|pwd)["']?\s*[:=]\s*["']?[^\s"']{8,}["']?/i,
  },
];

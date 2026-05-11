// Patterns for PII and secrets. Mask functions return true if the matched
// substring should be considered a real hit (e.g. Luhn-valid credit cards).

export const PII_PATTERNS = [
  {
    name: 'credit_card',
    regex: /\b(?:\d[ -]*?){13,19}\b/,
    mask: (s) => luhnCheck(s.replace(/[^0-9]/g, '')),
  },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/, mask: () => true },
  { name: 'sin', regex: /\b\d{3}-\d{3}-\d{3}\b/, mask: () => true },
];

export const SECRET_PATTERNS = [
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9-_]{32,}\b/ },
  { name: 'github_token', regex: /\bgh[ps]_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws_access_key', regex: /\bAKIA[A-Z0-9]{16}\b/ },
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

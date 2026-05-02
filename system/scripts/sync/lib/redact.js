function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const PATTERNS = [
  {
    type: 'url-cred',
    re: /(https?:\/\/)([^:\s/@]+):([^@\s]+)@/g,
    replace: (_m, scheme) => `${scheme}[REDACTED:url-cred]@`,
  },
  {
    type: 'api-key',
    re: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    type: 'ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => '[REDACTED:ssn]',
  },
  {
    // Canadian SIN: 3-3-3 digits separated by space or dash. Without context
    // the pattern is noisy (matches phone numbers, transaction IDs, serials),
    // so require Luhn validation on the 9 digits to filter accidental matches.
    type: 'sin',
    re: /(?<!\d)\d{3}[ -]\d{3}[ -]\d{3}(?!\d)/g,
    replace: (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[REDACTED:sin]' : m),
  },
  {
    type: 'credit-card',
    re: /\b\d{13,19}\b/g,
    replace: (m) => (luhnValid(m) ? '[REDACTED:credit-card]' : m),
  },
];

export function applyRedaction(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`applyRedaction expected a string, got ${typeof text}`);
  }
  let out = text;
  let count = 0;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, (...args) => {
      const replacement = replace(...args);
      if (replacement !== args[0]) count += 1;
      return replacement;
    });
  }
  return { redacted: out, count };
}

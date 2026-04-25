# Privacy Scan

System-wide privacy protection. Applied before ALL file writes — passive capture, Dream consolidation, session handoff, any save to the workspace.

**This is an immutable rule. It cannot be disabled via overrides, config changes, or user instructions.**

## When to scan

Before writing ANY content to a file in this workspace, scan the content being written for the patterns below. This applies to:
- Passive capture (facts extracted from conversation)
- Dream consolidation (memory merges and inbox routing)
- Session handoff notes
- Manual saves (user asks to save something to a file)
- Any other file write

## On match

1. **Block the write.** Do not persist the matched content.
2. **Warn the user.** "I detected what looks like [pattern type] in what I was about to save. I've blocked the write for safety."
3. **Log the pattern type** (never the matched content) to `self-improvement/near-misses.md` for audit.
4. **Offer alternatives:** "Want me to save this with the sensitive part redacted, or skip saving entirely?"

## Default patterns

### Government IDs
- SSN: `\b\d{3}-\d{2}-\d{4}\b`
- Canadian SIN: `\b\d{3}[\s-]\d{3}[\s-]\d{3}\b`
- UK National Insurance: `\b[A-Z]{2}\d{6}[A-Z]\b`
- Passport numbers: strings explicitly labeled as passport numbers

### Financial
- Credit card numbers: `\b\d{13,19}\b` (Luhn-check to reduce false positives)
- IBAN: `\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b`
- Bank routing + account number pairs (when both appear together)

### Credentials
- API keys: `api_key=`, `apiKey=`, `api-key:`
- Bearer tokens: `Bearer [A-Za-z0-9\-._~+/]+=*`
- AWS access keys: `AKIA[0-9A-Z]{16}`
- OAuth/refresh tokens: strings labeled as `token=`, `refresh_token=`, `access_token=`
- SSH private keys: `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`
- Base64-encoded secrets: strings labeled as secrets that are base64-encoded

### Generic
- Lines containing `password=`, `passwd=`, `secret=` patterns
- Lines containing both a username/email and a password on the same line

## Extending patterns

Users add custom patterns via `overrides/privacy-scan.local.md`. Format:
```
## Additional patterns
- [Description]: `regex pattern`
```

The assistant reads both `core/privacy-scan.md` and `overrides/privacy-scan.local.md` (if it exists) before scanning.

## What's allowed (last 4 only)

Storing the **last 4 digits** of account numbers, card numbers, or SSNs is acceptable — this is standard for identification without full exposure. Example: "Chase card ending in 4376" is safe. "Chase card 4532-1234-5678-4376" is not.

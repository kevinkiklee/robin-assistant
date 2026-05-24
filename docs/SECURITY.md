# Security policy

## Reporting a vulnerability

Use GitHub's **private security advisory** feature on this repository to report security issues. Do not open public issues for security problems.

We aim to triage within 7 days.

## Scope

Robin runs locally and stores personal data in `user-data/` (gitignored). Issues worth reporting:

- **Secret leakage** — anything that exposes contents of `user-data/config/secrets/`, OAuth tokens, or API keys in logs, telemetry, error messages, or external requests
- **Capability escapes** — integrations bypassing their declared `permissions.network`, `permissions.fs`, or `permissions.memory.namespaces`
- **Path traversal** — code or configs allowing reads/writes outside `user-data/`
- **MCP tool surface leaks** — tools that expose data the requesting client shouldn't have access to (e.g., reading content from a project that opted out of `robin-extension`)
- **Migration tool** writing to v2's data (the migration is read-only against v2 by design)

## Out of scope

- Issues that require attacker-controlled access to your machine already (Robin trusts your local UID by design)
- Bugs in upstream dependencies (file with that project; we'll update once they patch)
- Theoretical attacks without a concrete impact path

## Hardening defaults

- All native `fetch` in integration code is wrapped by a host-allowlisted proxy declared in `integration.yaml`
- `secrets/secrets.age` supports age-encrypted secrets; the daemon decrypts at boot
- gitleaks runs in CI on every push
- Telemetry payloads are zod-validated; user content is never written into `events.payload`, only into `events_content.body` (gated by audit-meta on reads)

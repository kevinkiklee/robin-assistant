# Cycle-1b Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-30-cycle-1b-outbound-policy-design.md`
**Depends on:** cycle-1a (sentence-hash haystack source).

## Step 1 — `system/scripts/lib/policy-refusals-log.js`

Append-only log helper (forward name; cycle-2a renames `outbound-refusals` → `policy-refusals`). Functions:
- `appendPolicyRefusal(workspaceDir, { kind, target, layer, reason, contentHash })` — TSV append, atomic.
- `readRecentRefusalHashes(workspaceDir, kind, windowMs)` — tail-read for dedup checks.
- Rotation at 1MB.

Test: `system/tests/security/policy-refusals-log.test.js`.

## Step 2 — `system/scripts/lib/sync/untrusted-index.js`

Sentence-hash index helpers:
- `splitSentences(text)` — split on `.!?\n\s*\n\n\s*[-*]\s\|`. Drop sentences <20 chars after trim.
- `fnv1a64(s)` — hash function.
- `loadOrRefreshIndex(workspaceDir)` — read `user-data/state/untrusted-index.json`. Stat all source files; if any newer than recorded mtime, rebuild that source's entry. Returns `{ sources: { path: {mtime, hashes[]} } }`.
- `updateIndexForFile(workspaceDir, relPath, content)` — wired into `atomicWrite` when `opts.trust === 'untrusted'`. Re-extracts sentences (post-frontmatter, post-marker stripping), hashes, replaces source entry.

Test: `system/tests/security/untrusted-index.test.js`.

## Step 3 — `system/scripts/lib/outbound-policy.js`

Three layers + error class:

```js
export class OutboundPolicyError extends Error {
  constructor(reason, layer) { super(reason); this.layer = layer; this.reason = reason; }
}
export function assertOutboundContentAllowed({ content, target, workspaceDir, ctx = {} }) {
  checkTaint({ content, workspaceDir });
  checkSensitiveShapes({ content });
  checkTarget({ content, target, workspaceDir, ctx });
}
```

- `checkTaint`: load index, hash outbound sentences, Set-membership check.
- `checkSensitiveShapes`: redact patterns (reuse from `redact.js` SECRET_PATTERNS) + iterate `process.env` for values >=30 chars matching `/^[A-Za-z0-9_-]+$/`, substring check.
- `checkTarget`: target string starts with `github:`, `spotify:`, or `discord:`, dispatch to per-tool sub-checks. github reads cached PAT scope. discord verifies target == `ctx.inboundOrigin`.

Tests: `outbound-policy-{taint,secrets,target,cache}.test.js`.

## Step 4 — `system/scripts/lib/github-allowlist.js`

GitHub repo list cache:
- `loadGithubAllowlist(workspaceDir)` — read cache; if expired (1h TTL) or missing, fetch `/user/repos?per_page=100&affiliation=owner,collaborator,organization_member`, paginate via `Link: ... rel="next"`. Cache to `user-data/state/github-allowlist-cache.json`.
- `invalidateGithubAllowlist(workspaceDir)` — delete cache file. Called on 401/403.

## Step 5 — Wire into sync writers

Update `markdown.js:atomicWrite` to call `updateIndexForFile` after the write succeeds (when `opts.trust` is set).

## Step 6 — Wire `outbound-policy` into write tools

For `system/skeleton/scripts/{github-write,spotify-write,discord-bot}.js`:

- **github-write.js / spotify-write.js**: wrap outbound HTTP. On `OutboundPolicyError`, append refusal log + `process.exit(11)`.
- **discord-bot.js**: wrap subprocess output reply. On error, replace content with `(declined to send full reply: outbound policy layer N — <reason>)`. Don't exit (long-lived process).

Note: `github-write.js`, `spotify-write.js`, `discord-bot.js` live in `user-data/scripts/` per integrations.md (Kevin's instance). For the package, wire the equivalent skeleton files in `system/skeleton/scripts/`.

## Step 7 — Create `system/rules/security.md`

New file. Contents:
- Outbound policy detail (layers, refusal log, refusal-note convention).
- Cycle-1a's untrusted-ingress detail (frontmatter, markers, sanitization rules) — moved out of AGENTS.md to thin always-loaded prompt.
- Pointer to `docs/security/audit-2026-04-30.md` (local-only audit reference).

## Step 8 — Update AGENTS.md

Append to Hard Rules:
> **Outbound writes.** `github-write`, `spotify-write`, and `discord-bot` replies are gated by `system/scripts/lib/outbound-policy.js`. Self-police: don't include content from `trust:untrusted` files, secrets, or env values. Mechanical backstop catches violations. See `system/rules/security.md`.

Add Tier 2 reference table row pointing to `system/rules/security.md`.

If feasible, move cycle-1a's verbose untrusted-ingress detail to security-rules.md (keep the cardinal rule in AGENTS.md only).

## Step 9 — Update morning-briefing protocol

`system/jobs/morning-briefing.md` adds "Outbound refusals review" step parallel to cycle-1a's quarantine review.

## Step 10 — Acceptance test

`system/tests/security/s4-github-injection.test.js` — synthetic injected GitHub knowledge file with `process.env`-shaped string; attempted github-write referencing the value → refused at layer=2.

## Step 11 — Run tests + commit

## DoD verification

Confirm against cycle-1b spec §13 DoD before complete.

# Cycle-2b Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-30-cycle-2b-tamper-detection-design.md`
**Depends on:** cycle-2a (`policy-refusals.log` infrastructure).

## Step 1 — `system/skeleton/security/manifest.json`

Skeleton manifest (shipped with package). Lists Robin's owned hooks; empty MCP arrays:

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|NotebookEdit", "command": "node system/scripts/hooks/claude-code.js --on-pre-tool-use" },
      { "matcher": "Bash", "command": "node system/scripts/hooks/claude-code.js --on-pre-bash" }
    ],
    "Stop": [
      { "command": "node system/scripts/hooks/claude-code.js --on-stop" }
    ],
    "SessionStart": [
      { "command": "node system/scripts/diagnostics/check-manifest.js" }
    ]
  },
  "mcpServers": { "expected": [], "writeCapable": [] }
}
```

## Step 2 — Setup.js extension

`system/scripts/cli/setup.js` (postinstall): if `user-data/security/manifest.json` doesn't exist, copy from skeleton. Idempotent.

## Step 3 — `system/scripts/lib/manifest.js`

Shared helpers:
- `loadManifest(workspaceDir)` — reads `user-data/security/manifest.json`. Throws clear error on missing/malformed. Auto-migrates v1 → v2 schema if needed (but v2 fields are cycle-2c).
- `enumerateMCPServers(workspaceDir)` — reads `.mcp.json` (project) + `~/.claude/mcp_settings.json`, `~/.claude/settings.json`, `~/Library/Application Support/Claude/claude_desktop_config.json` (global candidates). Deduped sorted list. Fails soft on missing paths.
- `loadCurrentSettings(workspaceDir)` — reads `.claude/settings.json`.
- `fnv1a64(s)` — hash function (or import from cycle-1b's untrusted-index.js).

Test: `system/tests/security/mcp-enumeration.test.js`.

## Step 4 — `system/scripts/diagnostics/check-manifest.js`

Main entrypoint (SessionStart hook). Algorithm:

1. Resolve `workspaceDir` from `ROBIN_WORKSPACE` or `process.cwd()`.
2. Read manifest. Missing → stderr WARNING, exit 0 (fail-soft).
3. Read current settings + MCP list.
4. `computeDrift(expected, currentSettings, currentMCP)` returns array of `{severity, kind, detail, hash}` objects per spec §4.3.
5. `emitDrift(workspaceDir, drift)`:
   - Severe entries: stderr lines (bound to ≤5; collapse beyond).
   - Mild >5: collapsed stderr.
   - All entries: log via `appendPolicyRefusal(kind=tamper, layer=severe|mild|info)` after dedup-24h check.
6. Top-level try/catch fail-soft: error → log + warning to stderr; exit 0 (don't block sessions on bugs).

Tests: `manifest-drift-hooks.test.js`, `manifest-drift-mcp.test.js`, `check-manifest-emit.test.js`, `check-manifest-dedup.test.js`, `check-manifest-fail-soft.test.js`.

## Step 5 — `system/scripts/diagnostics/manifest-snapshot.js`

Default mode: build manifest-shaped JSON from current state, write to stdout.
`--apply --confirm-trust-current-state`: overwrite `user-data/security/manifest.json`. Single-flag `--apply` exits 1 with explanation.

Test: `system/tests/security/manifest-snapshot.test.js`.

## Step 6 — Add `readRecentRefusalHashes` to `policy-refusals-log.js`

If not added in cycle-2a, add now. Reads tail of log (~10KB), filters by kind + window, returns Set of contentHashes.

## Step 7 — Update `.claude/settings.json`

Add SessionStart hook:
```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node system/scripts/diagnostics/check-manifest.js" }] }
```

(No `matcher` if SessionStart hooks don't filter; verify schema.)

## Step 8 — Update AGENTS.md + `system/rules/security.md`

AGENTS.md: 1 line for tamper detection rule.
`security-rules.md`: append manifest schema, update workflow, severity classifier, limitations. Bootstrap walkthrough A (first deploy) + B (legitimate edits).

## Step 9 — Acceptance tests

- `s10-fork-hook-tampering.test.js` — synthetic settings.json with extra hook → severe drift logged.
- `s9-mcp-compromise.test.js` — synthetic MCP in writeCapable but not expected → severe drift logged.

## Step 10 — Update morning-briefing protocol

Add tamper review step. Group by kind. Flag `hook-internal-error` for triage.

## Step 11 — Run tests + commit

## DoD verification

Confirm against cycle-2b spec §14 DoD before complete.

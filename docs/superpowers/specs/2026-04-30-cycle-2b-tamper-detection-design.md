# Cycle-2b — Tamper Detection (hooks + MCP)

**Date:** 2026-04-30
**Author:** Kevin (with Claude)
**Status:** Draft — implementation paused (other agent active on package)
**Source audit:** `docs/security/audit-2026-04-30.md` (audit pinned SHA: `b5f413c1ba7c60910a1f2c111b248c1ae6daa9f3`)
**Predecessor cycles:** cycle-1a, cycle-1b, cycle-2a (reuses `policy-refusals.log` + `system/security-rules.md`).
**Source-audit gap IDs:** G-28, G-37
**Acceptance scenarios:** S9 (compromised MCP server), S10 (hook tampering)

> Note: G-30 was originally listed as a cycle-2b gap. Pulled into cycle-2a (the Bash hook addition naturally extends PreToolUse matchers, which IS the G-30 fix). Cycle-2b's scope is now G-28 + G-37 only.

---

## 1. Goals & non-goals

### Goals
- Detect drift in `.claude/settings.json` hook entries against a trusted manifest.
- Detect drift in the loaded MCP server list against the same manifest.
- Surface severe drift to the user immediately (model context). Surface mild drift retrospectively (morning briefing).
- Maintain Kevin's autonomy: no confirm prompts at session start; no everyday CLI commands; one-time first-deploy bootstrap with explicit two-flag opt-in.
- Pass acceptance scenarios S9 and S10.

### Non-goals
- Cryptographic signing of the manifest (detection layer is git diff review, not crypto; documented as known limitation).
- Runtime MCP-server bundle hash pinning (heavier; cycle-3+ if observed need).
- Auto-rejecting suspicious MCPs (warn-and-log only — Kevin decides).
- Defending against an attacker who already has filesystem access at the manifest path (T3 territory; out of scope per audit threat model).

### Constraints
- Must function alongside the other agent's `feat/a3-session-end-sweep` (Stop hook, `.claude/settings.json` edits). Re-read the file before edits.
- Reuses `policy-refusals.log` infrastructure from cycle-1b/2a (gains `kind=tamper` rows).
- SessionStart hook target: <50ms typical / <100ms ceiling.
- Manifest is per-install (not shipped). Lives in `user-data/security/`. Skeleton ships in `system/skeleton/security/` and is copied on first install.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Mechanism — Manifest-based drift detection                      │
│                                                                 │
│  user-data/security/manifest.json     ← per-install trusted     │
│              │                          baseline (gitignored).  │
│              ▼                                                  │
│   system/scripts/                                               │
│     check-manifest.js  ←─── SessionStart hook                   │
│         │                                                       │
│         ├─ reads .claude/settings.json    (current hooks)      │
│         ├─ reads .mcp.json (if present)   (project MCP)         │
│         ├─ reads ~/.claude/<config>       (global MCP)          │
│         ▼                                                       │
│   diff vs manifest                                              │
│         │                                                       │
│   ┌─────┴─────┐                                                 │
│   ▼           ▼                                                 │
│  severe    mild/info                                            │
│   │           │                                                 │
│   ▼           ▼                                                 │
│  stderr    policy-refusals.log (kind=tamper)                    │
│  (model    (deduped 24h; surfaced in morning briefing as       │
│  context)  novel-since-last-briefing only)                      │
└─────────────────────────────────────────────────────────────────┘

   system/skeleton/security/manifest.json  ← shipped template
   system/scripts/manifest-snapshot.js     ← read-only diff helper
                                              + --apply --confirm-trust-current-state
                                                for first-deploy bootstrap.
```

---

## 3. Manifest design

### 3.1 Location

- **Per-install (live):** `user-data/security/manifest.json` (gitignored under `user-data/`).
- **Skeleton (shipped):** `system/skeleton/security/manifest.json` (tracked in package).
- **Setup behavior:** `system/scripts/setup.js` (postinstall) copies skeleton → live if live doesn't exist. Idempotent: never overwrites an existing manifest.

### 3.2 Schema

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|NotebookEdit", "command": "node system/scripts/claude-code-hook.js --on-pre-tool-use" },
      { "matcher": "Bash", "command": "node system/scripts/claude-code-hook.js --on-pre-bash" }
    ],
    "Stop": [
      { "command": "node system/scripts/claude-code-hook.js --on-stop" }
    ],
    "SessionStart": [
      { "command": "node system/scripts/check-manifest.js" }
    ]
  },
  "mcpServers": {
    "expected": [],
    "writeCapable": []
  }
}
```

`hooks` is keyed by event (`PreToolUse`, `Stop`, `SessionStart`, …). Each entry has a `matcher` (regex pattern Claude Code uses) and a `command` string. Matcher is omitted for events that don't filter (Stop, SessionStart).

`mcpServers.expected` is the allowlist of MCP servers Kevin has accepted. `writeCapable` is a subset (or independent list) of those with write capability — flagging them helps Kevin reason about blast radius but does not affect drift behavior.

### 3.3 Skeleton vs. live

The shipped skeleton lists Robin's owned hooks and empty MCP arrays. After install:
- The live manifest at `user-data/security/manifest.json` is initialized from the skeleton.
- Kevin populates `mcpServers.expected` (and `writeCapable` where applicable) on first deploy via the bootstrap flow (§7).
- Kevin's edits live only in `user-data/`; future `npm install`s don't overwrite.

### 3.4 No cryptographic signing

The manifest is plain JSON. An attacker who can edit `.claude/settings.json` can also edit `user-data/security/manifest.json`. The detection layer is **git review of pull diffs**: if a fork commits a malicious hook AND its corresponding manifest update, both diffs appear in the pull. Not a defense against an attacker already on the filesystem; documented in `system/security-rules.md` known limitations.

---

## 4. `check-manifest.js`

### 4.1 Lifecycle

Runs as the `SessionStart` hook command. Each new Claude Code session triggers it. Receives the standard hook event JSON on stdin (or empty stdin — current Claude Code's SessionStart contract; verify at implementation time).

### 4.2 Algorithm

```js
async function main() {
  const workspaceDir = process.env.ROBIN_WORKSPACE || process.cwd();
  const manifestPath = join(workspaceDir, 'user-data/security/manifest.json');

  if (!existsSync(manifestPath)) {
    process.stderr.write('WARNING: user-data/security/manifest.json missing; tamper detection inactive.\n');
    process.exit(0);  // fail-soft
  }

  const expected = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const currentSettings = readJSONOrEmpty(join(workspaceDir, '.claude/settings.json'));
  const currentMCP = enumerateMCPServers(workspaceDir);

  const drift = computeDrift(expected, currentSettings, currentMCP);

  emitDrift(workspaceDir, drift);
  process.exit(0);
}
```

### 4.3 `computeDrift`

```js
function computeDrift(expected, currentSettings, currentMCP) {
  const drift = [];

  // 1. Hooks: any current hook command not in manifest → severe.
  for (const [event, hooks] of Object.entries(currentSettings.hooks ?? {})) {
    for (const hook of hooks) {
      const expectedHooks = expected.hooks[event] ?? [];
      const matched = expectedHooks.some(e =>
        (e.matcher ?? null) === (hook.matcher ?? null) &&
        (hook.hooks ?? [hook]).some(h => h.command === e.command)
      );
      if (!matched) {
        drift.push({
          severity: 'severe',
          kind: 'unexpected-hook',
          event,
          matcher: hook.matcher ?? '*',
          detail: `${event}/${hook.matcher ?? '*'}: ${(hook.hooks ?? [hook]).map(h => h.command).join(', ')}`,
          hash: fnv1a(JSON.stringify(hook)),
        });
      }
    }
  }

  // 2. Hooks in manifest missing from current → info (Kevin removed; intentional).
  // (Skip — no action.)

  // 3. MCP servers not in expected → mild OR severe.
  for (const mcp of currentMCP) {
    if (!expected.mcpServers.expected.includes(mcp)) {
      const isWriteCapable = expected.mcpServers.writeCapable.includes(mcp);
      drift.push({
        severity: isWriteCapable ? 'severe' : 'mild',
        kind: 'unexpected-mcp',
        detail: `${mcp}${isWriteCapable ? ' (write-capable)' : ''}`,
        hash: fnv1a(`mcp:${mcp}`),
      });
    }
  }

  return drift;
}
```

**Heuristic dropped:** the previous `hasWriteToolNames` check is removed (would have required either live MCP queries or a separately-maintained tool catalog — both add complexity for marginal benefit). New MCPs default to mild drift; Kevin promotes write-capable ones to the explicit allowlist on triage.

### 4.4 `emitDrift`

```js
function emitDrift(workspaceDir, drift) {
  if (drift.length === 0) return;

  const severe = drift.filter(d => d.severity === 'severe');
  const mild = drift.filter(d => d.severity === 'mild');

  // Stderr surface — bounded.
  if (severe.length > 0) {
    if (severe.length <= 5) {
      for (const d of severe) {
        process.stderr.write(`TAMPER DRIFT [severe]: ${d.kind} - ${d.detail}\n`);
      }
    } else {
      process.stderr.write(
        `TAMPER DRIFT [severe]: ${severe.length} entries — see policy-refusals.log\n`
      );
    }
  }
  if (mild.length > 5) {
    process.stderr.write(
      `TAMPER DRIFT [mild]: ${mild.length} entries — see policy-refusals.log\n`
    );
  } else if (mild.length > 0) {
    // ≤5 mild: still log only (don't spam stderr); morning briefing surfaces.
  }

  // Refusal log — deduped 24h.
  const recent = readRecentRefusalHashes(workspaceDir, 'tamper', 24 * 60 * 60 * 1000);
  for (const d of drift) {
    if (recent.has(d.hash)) continue;  // skip dedup
    appendPolicyRefusal(workspaceDir, {
      kind: 'tamper',
      target: d.kind,
      layer: d.severity,
      reason: d.detail,
      contentHash: d.hash,
    });
  }
}
```

`readRecentRefusalHashes(workspaceDir, kind, windowMs)` reads the tail of `policy-refusals.log`, returns a Set of `contentHash` values for entries with the given `kind` within the window. Bounded read — only the last ~10KB of the log file (covers ~100 entries; more than enough for 24h of tamper events).

### 4.5 MCP enumeration

```js
function enumerateMCPServers(workspaceDir) {
  const servers = new Set();

  // 1. Project-scoped MCP config.
  const projectMCP = join(workspaceDir, '.mcp.json');
  if (existsSync(projectMCP)) {
    const config = readJSONOrEmpty(projectMCP);
    for (const name of Object.keys(config.mcpServers ?? {})) servers.add(name);
  }

  // 2. Global Claude Code MCP config.
  // KNOWN UNKNOWN: path may vary across Claude Code versions. Verify at impl time.
  // Try several known locations; fail soft on each.
  const globalCandidates = [
    join(homedir(), '.claude', 'mcp_settings.json'),
    join(homedir(), '.claude', 'settings.json'),  // some versions colocate
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ];
  for (const path of globalCandidates) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(readFileSync(path, 'utf-8'));
      for (const name of Object.keys(config.mcpServers ?? {})) servers.add(name);
    } catch {
      // Malformed — skip, log info.
    }
  }

  return [...servers].sort();
}
```

If discovery returns empty when MCPs are clearly loaded in the session, log an info entry and proceed (fail-soft). The implementer verifies the current path on Claude Code's docs before deployment.

### 4.6 Performance

- Read manifest: ~5KB JSON, ~1ms.
- Read `.claude/settings.json`: ~5KB, ~1ms.
- Read MCP config files: ~5–20KB total, ~3–5ms.
- `computeDrift`: in-memory, O(hooks + mcps), <1ms.
- `readRecentRefusalHashes`: tail-read ~10KB of log file, ~2ms.
- Write refusal log entries: append, atomic, ~1ms per entry.
- Stderr write: instant.

Total target: <30ms typical. <50ms ceiling. Node startup overhead (~30ms) dominates; the work itself is trivial.

### 4.7 Fail-closed where it counts

The hook itself uses a top-level try/catch (parallel to cycle-2a's `--on-pre-bash` pattern). Any uncaught error logs as `kind=tamper`, `layer=hook-internal-error`, exits 0 (so SessionStart doesn't break sessions on bugs). SessionStart unlike PreToolUse is informational; failing-closed by blocking session start would be too aggressive.

```js
} catch (err) {
  try {
    appendPolicyRefusal(workspaceDir, {
      kind: 'tamper',
      target: 'hook',
      layer: 'hook-internal-error',
      reason: `HOOK_INTERNAL_ERROR: ${err?.message || String(err)}`,
      contentHash: '',
    });
  } catch { /* logging itself failed */ }
  process.stderr.write(`TAMPER CHECK FAILED: ${err?.message || String(err)}\n`);
  process.exit(0);  // don't block session start
}
```

Morning briefing flags `hook-internal-error` for triage — same pattern as cycle-2a.

---

## 5. `manifest-snapshot.js`

### 5.1 Default mode (read-only)

```sh
node system/scripts/manifest-snapshot.js
```

Reads current `.claude/settings.json` and current MCP server list. Builds a manifest-shaped JSON object. Writes to stdout. Does not modify any file. Safe to run any time.

Useful flow:

```sh
node system/scripts/manifest-snapshot.js > /tmp/snapshot.json
diff user-data/security/manifest.json /tmp/snapshot.json
$EDITOR user-data/security/manifest.json   # paste in additions
```

### 5.2 `--apply --confirm-trust-current-state` (first-deploy bootstrap)

```sh
node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state
```

Overwrites `user-data/security/manifest.json` with current state. The two-flag pattern (separate `--apply` + explicit `--confirm-trust-current-state`) prevents accidental "snapshot accepts whatever drift is in place." The flag name is intentionally long.

Use only at first deploy or when Kevin has manually reviewed every entry.

If `--apply` is given without `--confirm-trust-current-state`, exits 1 with:
```
manifest-snapshot.js --apply requires --confirm-trust-current-state to proceed.
This overwrites user-data/security/manifest.json with current state, which
accepts whatever is currently registered as trusted. Use only after reviewing.
```

### 5.3 Helper module reuse

`enumerateMCPServers` and the hook-introspection logic are exported from `check-manifest.js` (or split into a shared `lib/manifest.js`) so the snapshot helper reuses them — single source of truth for "what does the current state look like."

---

## 6. `.claude/settings.json` extension

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|NotebookEdit", "hooks": [...] },
      { "matcher": "Bash", "hooks": [...] }
    ],
    "Stop": [ ... ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node system/scripts/check-manifest.js" }
        ]
      }
    ]
  }
}
```

The skeleton's `manifest.json` self-references this entry, so the manifest agrees with itself by construction (no drift on a clean install).

---

## 7. First-deploy bootstrap (user-facing flow)

Kevin's documented post-install steps for cycle-2b. Lives in `system/security-rules.md`:

### 7.1 First time (after cycle-2b ships)

```sh
# 1. Verify the skeleton landed.
ls user-data/security/manifest.json     # exists; copied by setup.js (postinstall)

# 2. Capture current state for review.
node system/scripts/manifest-snapshot.js > /tmp/current-state.json

# 3. Diff against the live manifest.
diff user-data/security/manifest.json /tmp/current-state.json

# 4a. EITHER — manually copy the additions you trust:
$EDITOR user-data/security/manifest.json

# 4b. OR — for first-deploy convenience, accept current state in one shot:
node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state

# 5. Verify drift detection now passes.
node system/scripts/check-manifest.js
# expected: silent (exit 0), no stderr.
```

### 7.2 Adding a new MCP server later

```sh
# Install the MCP normally per Claude Code docs.

# Next session start emits:
#   TAMPER DRIFT [mild]: unexpected-mcp - new-mcp-name

# Edit the manifest.
$EDITOR user-data/security/manifest.json
# Add "new-mcp-name" to mcpServers.expected.
# If it can write to external services, also add to writeCapable.

# Subsequent sessions: silent.
```

### 7.3 Hook change

Same as 7.2 but in the `hooks` section. New hooks are `severe` drift — Robin's reply at session start surfaces the warning.

### 7.4 Investigating unexpected drift

```sh
# Severe drift surfaces at session start. Investigate:
git log -- .claude/settings.json
diff <(git show HEAD~10:.claude/settings.json) .claude/settings.json
# If malicious, revert + rotate any secrets that may have been exfil'd.
```

---

## 8. Refusal log evolution (cycle-2a → cycle-2b)

`policy-refusals.log` schema unchanged from cycle-2a. New `kind=tamper` rows. Layer values: `severe`, `mild`, `info`, `hook-internal-error`.

### 8.1 Dedup logic (new)

`appendPolicyRefusal` (or a wrapper specific to tamper kind) checks the recent log tail for an entry matching `kind+contentHash` within a 24h window. If found, skips the write. The skipped event is still emitted to stderr per emit logic (so severe drift remains visible at session start even when log is deduped).

### 8.2 Morning-briefing novelty filter

Morning-briefing protocol's "policy refusals" section already filters by "since last briefing." Cycle-2b adds: for `kind=tamper`, group by `contentHash`; show ENTRIES new since last briefing only; collapse ongoing-but-unchanged drift to a one-liner ("3 ongoing tamper drift entries unchanged since last review — see log").

Concrete update to `system/jobs/morning-briefing.md`:

```markdown
**Policy refusals review.**
[...existing logic...]

For kind=tamper specifically:
1. Read policy-refusals.log entries since last briefing cursor.
2. Group by contentHash.
3. For each unique hash with new entries: show timestamp, severity, target, reason.
4. If contentHash also has entries before the cursor: append "(ongoing since YYYY-MM-DD)".
5. Collapse: if more than N ongoing-unchanged entries exist (cursor-cross only), show "(N ongoing tamper drift entries unchanged)".
6. Flag layer=hook-internal-error entries with [TRIAGE] prefix.
```

---

## 9. AGENTS.md and `system/security-rules.md`

### 9.1 AGENTS.md change

One line under Hard Rules:

```markdown
- **Tamper detection.** Drift in `.claude/settings.json` hooks or in the loaded MCP server list is checked at session start by `system/scripts/check-manifest.js` against `user-data/security/manifest.json`. Severe drift surfaces in the model context immediately; mild/info goes to `policy-refusals.log` (deduped 24h) for morning-briefing review. See `system/security-rules.md`.
```

Cumulative AGENTS.md additions across all four security cycles: ~5 lines net (cycle-1a +5, cycle-1b -2, cycle-2a +1, cycle-2b +1).

### 9.2 `system/security-rules.md` additions

- Manifest schema reference.
- First-deploy bootstrap walkthrough (§7 above, copied verbatim).
- Severity classifier table (severe / mild / info).
- Limitations: plain-text manifest; detection layer = git diff review; no defense against attacker already on filesystem.
- MCP discovery path "known unknown" caveat.

Estimated addition: ~80 lines.

---

## 10. Tests

### 10.1 Unit (deterministic)

`system/tests/security/`:
- `manifest-drift-hooks.test.js` — synthetic manifest + synthetic settings.json combinations:
  - No drift (exact match).
  - Severe drift (extra hook command).
  - Info drift (manifest entry missing from current — should not appear in output).
- `manifest-drift-mcp.test.js` — MCP server combinations:
  - No drift (all expected).
  - Mild drift (new MCP, not write-capable).
  - Severe drift (new MCP listed in writeCapable).
- `check-manifest-emit.test.js` — `emitDrift` bounding:
  - 3 severe → 3 stderr lines.
  - 6 severe → 1 summary line.
  - 6 mild → 1 summary line; 4 mild → 0 stderr lines (log only).
- `check-manifest-dedup.test.js` — second invocation within 24h with same drift → no new log entry; stderr still emitted.
- `check-manifest-fail-soft.test.js` — missing manifest → exit 0 with warning; malformed JSON → exit 0 with hook-internal-error log.
- `manifest-snapshot.test.js` — read-only mode produces valid JSON; `--apply` without `--confirm-trust-current-state` exits 1; both flags overwrites manifest.
- `mcp-enumeration.test.js` — mock filesystem with project + global MCP configs; assert deduped + sorted output.

### 10.2 Acceptance (mechanical)

- `s10-fork-hook-tampering.test.js` — synthetic `.claude/settings.json` with extra hook entry not in manifest → `severe` drift; refusal log entry; stderr output.
- `s9-mcp-compromise.test.js` — synthetic MCP server name in current state, in `writeCapable` allowlist but NOT in `expected` (e.g., a MCP got renamed maliciously) → `severe` drift.

### 10.3 Smoke (manual, post-deploy)

1. Add a fake hook to `.claude/settings.json`. Start a new Claude Code session. Confirm stderr surfaces "TAMPER DRIFT [severe]" and the refusal log has a new tamper entry.
2. Add a fake MCP name to a discovered config. Confirm mild drift line in refusal log.
3. Run `node system/scripts/manifest-snapshot.js > /tmp/snap.json`. Diff vs. live manifest. Confirm shape matches.
4. Run `node system/scripts/manifest-snapshot.js --apply` without the second flag. Confirm exit 1 + the explanatory message.
5. Confirm session start with no drift completes silently in <50ms (timing measured via shell `time`).

---

## 11. Migration

1. **Order:** deploys after cycle-2a (uses `policy-refusals.log` + `system/security-rules.md`).
2. **Skeleton ship:** `system/skeleton/security/manifest.json` lands in the package; `setup.js` (postinstall) copies it to `user-data/security/manifest.json` if not already present.
3. **First session after deploy:** Kevin sees drift entries for every MCP not in the (initially empty) manifest. He runs the bootstrap (§7.1) — likely option 4b (`--apply --confirm-trust-current-state`) for first-deploy convenience.
4. **Subsequent sessions:** silent unless drift appears.

No data migration. No file rewrites of existing logs.

---

## 12. Risk register

| Risk | Mitigation |
|---|---|
| Manifest itself can be edited by an attacker on the filesystem | Detection layer is git-diff review on pulls. Documented in `system/security-rules.md` known limitations. T3 already accepted as a gap (G-33; cycle-2c territory). |
| Initial deploy floods refusal log with mild MCP drift | One-time triage via bootstrap mode (`--apply --confirm-trust-current-state`); subsequent sessions silent. |
| MCP discovery path varies across Claude Code versions | `enumerateMCPServers` tries multiple known paths; fails soft (returns empty) on each. Re-verify path during implementation. Update `system/security-rules.md` with the canonical path once verified. |
| Heuristic tool-name detection dropped → write-capable MCPs default to mild drift | Acceptable. Kevin promotes them to `writeCapable` allowlist on triage. Worst case: a write-capable MCP is "mild" for one session before Kevin reads morning briefing. Alternative (the heuristic) added complexity for marginal benefit. |
| SessionStart hook adds session-start latency | <30ms typical / <50ms ceiling. Node startup dominates. If unacceptable in practice, port to a faster runtime (out of scope for cycle-2b). |
| Concurrent SessionStart hooks (multiple parallel Claude Code instances) race on log writes | `appendFileSync` atomic at OS level. No race. |
| `--apply --confirm-trust-current-state` accepts malicious drift if Kevin runs it without reviewing | Two-flag pattern is the friction; the flag name is intentionally long. Documentation explicitly warns. Acceptable trade-off for first-deploy convenience. |
| Other agent's branch has changed `.claude/settings.json` shape | Re-read before edits. SessionStart entry is additive; merge cleanly. |
| 24h dedup window misses an attacker who plants drift, snapshots, removes, replants every 25h | The first plant is logged. Subsequent identical replants are deduped. The first occurrence visibility is preserved. Persistent attacker would still appear in refusal log on first plant; morning briefing surfaces it. Cycle-2c could add anomaly detection on log patterns if needed. |

---

## 13. Time budget

- **Target:** 0.75 working day.
- **Ceiling:** 1.5 working days.
- **Per-component:**
  - `manifest.json` skeleton + `system/scripts/setup.js` postinstall copy: 0.5h
  - `check-manifest.js`: 1.5h
  - `manifest-snapshot.js`: 0.5h
  - `enumerateMCPServers` + hook-introspection helper: 0.75h (path discovery is fiddly)
  - `.claude/settings.json` SessionStart entry: 0.25h
  - Refusal-log dedup (24h tail-read helper): 0.5h
  - Morning-briefing protocol update for tamper-novelty filter: 0.5h
  - Unit tests (7 files): 2h
  - Acceptance tests S9, S10: 1h
  - AGENTS.md + `system/security-rules.md`: 0.75h
  - Smoke + cleanup: 0.25h

---

## 14. Definition of done

1. `system/skeleton/security/manifest.json` ships with Robin's owned hooks; empty MCP arrays.
2. `setup.js` (postinstall) copies skeleton → `user-data/security/manifest.json` if absent.
3. `check-manifest.js` runs on SessionStart; computes drift; emits stderr per bounding rules; logs to `policy-refusals.log` with `kind=tamper`.
4. `manifest-snapshot.js` default-mode is read-only; `--apply --confirm-trust-current-state` overwrites; missing-confirm-flag exits 1 with explanation.
5. `enumerateMCPServers` reads project + global MCP configs; fails soft on missing paths; returns deduped sorted list.
6. Severity classifier matches Q1 hybrid (severe / mild / info).
7. Refusal-log entries deduped 24h via `readRecentRefusalHashes`.
8. AGENTS.md gains 1-line tamper rule. `system/security-rules.md` extended with manifest workflow + limitations + bootstrap walkthrough.
9. Morning-briefing protocol surfaces tamper drift with novelty filter; flags `hook-internal-error` for triage.
10. S9 and S10 acceptance tests pass.
11. Unit tests for drift-hooks, drift-mcp, emit, dedup, fail-soft, snapshot, mcp-enumeration — all pass.
12. Smoke tests (manual, 5 cases) pass.
13. Existing test suite green. Discord-bot still functions end-to-end.
14. Zero confirm prompts at session start (severe drift surfaces via stderr → model context only).
15. `<50ms` SessionStart hook latency in smoke timing.

---

## 15. Hand-off to cycle-2c

When cycle-2b signs off:
- Cycle-2c's spec frontmatter cites this spec's path + commit SHA + cycle-2a + cycle-1b + cycle-1a.
- Cycle-2c's brainstorm starts with G-01, G-02, G-03, G-05, G-13, G-27 — rule backstops + minor sync hardening.
- The manifest infrastructure from cycle-2b is reusable for cycle-2c if any additional config files need integrity tracking.
- `policy-refusals.log` continues to grow with new `kind` values as needed (cycle-2c may add `kind=rule-violation` for mechanical rule backstops).

---

## 16. Coupling note (other-agent collision)

At spec-write time, the other agent's `feat/a3-session-end-sweep` branch is active. Coupling concerns for cycle-2b:

- **`.claude/settings.json`**: cycle-2b adds a `SessionStart` hook entry. Other agent has been editing this file (Stop hook). Re-read before edits; merge SessionStart additively. Both can coexist.
- **`system/scripts/setup.js`**: cycle-2b adds a manifest-copy step to setup. Other agent's `760a1ee feat(migrations): 0014 seed learning-queue with starter questions` may have touched setup.js or the migration system. Re-read before edits.
- **AGENTS.md**: other agent edited Hard Rules and Session End sections. Cycle-2b appends one line to Hard Rules. Different lines; low conflict.
- **`system/scripts/lib/`**: cycle-2b adds new files (`policy-refusals-log.js` from cycle-2a is reused; new `lib/manifest.js` if extracted). Verify no naming collision before commit.

Implementation paused until user greenlights. Re-read this section + cycle-1a/1b/2a coupling notes when resuming.

---

# Cycle-2c Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-30-cycle-2c-rule-backstops-design.md`
**Depends on:** cycle-2b (manifest schema v1; extend to v2).

## Step 1 — Extend `claude-code-hook.js --on-pre-tool-use` with PII scan

Memory-write branch:
```js
const memoryPrefix = join(REPO_ROOT, 'user-data/memory/');
if (target.startsWith(memoryPrefix)) {
  const content = event.tool_input?.content ?? event.tool_input?.new_string ?? '';
  const { applyRedaction } = await import('./lib/sync/redact.js');
  const { count } = applyRedaction(content);
  if (count > 0) {
    appendPolicyRefusal(... kind: 'pii-bypass', layer: 'write-hook', ...);
    process.stderr.write(`WRITE_REFUSED [pii]: ${count} PII pattern(s) detected. Redact before retrying.\n`);
    process.exit(2);
  }
}
```

Lazy-import keeps non-memory writes fast.

Test: `system/tests/security/pii-write-hook.test.js`.

## Step 2 — High-stakes audit log

`system/scripts/lib/high-stakes-log.js`:
- `appendHighStakesWrite(workspaceDir, { target, contentHash })` — append to `user-data/runtime/state/telemetry/high-stakes-writes.log`. Dedup 1h on `target+contentHash`.

Add to hook (after PII check):
```js
const HIGH_STAKES_DESTINATIONS = [...];
if (HIGH_STAKES_DESTINATIONS.some(p => target.endsWith(p))) {
  appendHighStakesWrite(REPO_ROOT, { target: relativeTarget(target), contentHash: fnv1a(content) });
  // Continue — write proceeds.
}
```

Test: `system/tests/security/high-stakes-audit.test.js`.

## Step 3 — Manifest schema v2

Update `system/skeleton/security/manifest.json` with v2 shape:
```json
{
  "version": 2,
  "hooks": {...},
  "mcpServers": {...},
  "agentsmd": { "hardRulesHash": "", "lastSnapshot": "" },
  "userDataJobs": { "knownFiles": [] }
}
```

`loadManifest` auto-migrates v1 → v2 (adds empty fields, leaves rest untouched).

Test: `system/tests/security/manifest-v1-to-v2.test.js`.

## Step 4 — `system/scripts/lib/agentsmd-hash.js`

```js
export function extractSection(md, headerName) {
  const re = new RegExp(`^##\\s+${headerName}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

export function normalizeForHash(text) {
  return text.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function hashHardRules(agentsmdContent) {
  const section = extractSection(agentsmdContent, 'Hard Rules');
  if (!section) return null;
  return fnv1a64(normalizeForHash(section));
}
```

Tests: `extract-section.test.js`, `hash-normalize.test.js`, `agentsmd-hash.test.js`.

## Step 5 — Extend `check-manifest.js`

Add `checkAgentsMD(workspaceDir, expected)` — returns severity+kind based on hash compare. Empty baseline → info.
Add `checkUserDataJobs(workspaceDir, expected)` — readdir `user-data/runtime/jobs/*.md`, diff against `userDataJobs.knownFiles`. New files → mild drift.

Test: `userdata-jobs-drift.test.js`.

## Step 6 — Extend `manifest-snapshot.js`

Snapshot includes computed `hardRulesHash`, current `userDataJobs.knownFiles`, in v2 shape.

## Step 7 — Pattern frontmatter migration

`system/scripts/migrate-cycle-2c.js`:
- Walk `user-data/memory/self-improvement/patterns.md`.
- For each pattern frontmatter: add `last_fired: <today>` and `fired_count: 0` if missing.
- Idempotent.

## Step 8 — Pattern firings log helper

`system/scripts/lib/pattern-firings.js`:
- `readFirings(workspaceDir)` — read `user-data/runtime/state/pattern-firings.log`. Returns Map<pattern-name, [timestamps]>.
- `truncateFirings(workspaceDir)` — empty the log file.

The model writes via Bash echo (no helper needed for write side):
```sh
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t<pattern-name>" >> user-data/runtime/state/pattern-firings.log
```

Test: `pattern-firings-log.test.js`.

## Step 9 — Pattern TTL daemon

`system/scripts/memory/lib/pattern-ttl.js`:
- `DEFAULT_TTL_DAYS = 180`
- `processPatternTTL(workspaceDir)` — reads firings log, reads patterns.md, batch-updates frontmatter (last_fired + fired_count), truncates firings log, archives patterns over TTL to patterns-archive.md. Returns summary `{updated, archived, fired_count_total}`.

Per-pattern `ttl_days` override supported; if frontmatter has `ttl_days: <N>`, that wins.

Test: `pattern-ttl.test.js`.

## Step 10 — Update `system/jobs/dream.md`

Add TTL phase (call to `processPatternTTL`). Append summary line to journal.

## Step 11 — Update AGENTS.md + capture-rules.md

AGENTS.md: 1 line for backstops rule.
capture-rules.md (or AGENTS.md self-improvement section): instruct model to append to pattern-firings.log via Bash echo on pattern application.

Append `system/rules/security.md` with cycle-2c walkthroughs A/B/C/D.

## Step 12 — Update morning-briefing protocol

Add high-stakes-writes review step (aggregated by destination).

## Step 13 — Acceptance test

`s8-jailbreak-pii-write.test.js` — synthetic Write call with SSN content → blocked, refusal logged.

## Step 14 — Run tests + commit

## DoD verification

Confirm against cycle-2c spec §13 DoD before complete.

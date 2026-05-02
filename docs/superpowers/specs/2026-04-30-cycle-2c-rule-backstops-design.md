# Cycle-2c — Rule Backstops + Lifecycle Hygiene

**Date:** 2026-04-30
**Author:** Kevin (with Claude)
**Status:** Draft — implementation paused (other agent active on package)
**Source audit:** `docs/security/audit-2026-04-30.md` (audit pinned SHA: `b5f413c1ba7c60910a1f2c111b248c1ae6daa9f3`)
**Predecessor cycles:** cycle-1a, cycle-1b, cycle-2a, cycle-2b. Manifest schema v1 → v2; reuses `policy-refusals.log`; reuses cycle-1a's origin-tagging.
**Source-audit gap IDs:** G-01, G-02, G-03, G-05, G-27 (G-13 closed as cycle-1a side-effect; not in cycle-2c scope)
**Acceptance scenarios:** S8 (jailbreak bypassing privacy rule)

---

## 1. Goals & non-goals

### Goals
- Mechanical backstops for advisory rules previously dependent on model adherence (G-01 AGENTS.md hard rules check, G-02 PII pattern enforcement, G-03 user-data jobs override drift, G-05 high-stakes destination audit).
- Lifecycle hygiene for auto-promoted patterns (G-27 — 180-day TTL).
- Pass acceptance scenario S8.
- Maintain Kevin's autonomy: zero confirm prompts; mechanical defenses with retrospective surface in morning briefing.

### Non-goals
- Auto-redacting PII in writes (block-and-explain only — model retries with self-redaction).
- Per-rule fine-grained AGENTS.md drift attribution (whole "Hard Rules" section is the unit).
- Pattern resurrection from archive (manual restore by Kevin if needed).
- High-stakes-write blocking (audit-only; cycle-1a's origin tagging already prevents the worst case).
- Email/phone redaction patterns beyond what `redact.js` already covers.

### Constraints
- Must function alongside the other agent's `feat/a3-session-end-sweep` (Stop hook, AGENTS.md edits). Re-read before edits.
- Reuses `policy-refusals.log` infrastructure from cycle-2a/2b for `kind=pii-bypass`. High-stakes audits go to a separate file (kept distinct from refusals).
- Reuses cycle-2b's `user-data/security/manifest.json`; bumps schema to v2.
- Pattern-firings via Bash echo append (not blocked by cycle-2a sensitive patterns).

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Group A — Write-time backstops                                  │
│  Extend claude-code-hook.js --on-pre-tool-use:                  │
│   • Memory-write PII scan (G-02): block-and-explain on match.   │
│   • High-stakes destination audit (G-05): log-only,              │
│     surfaced in morning briefing.                               │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Group B — Integrity drift (manifest v2)                         │
│  user-data/security/manifest.json gains:                        │
│   • agentsmd.hardRulesHash (G-01) — fnv1a-64 of normalized      │
│     "## Hard Rules" section.                                    │
│   • userDataJobs.knownFiles (G-03) — allowlist of override      │
│     filenames.                                                  │
│  check-manifest.js extends to verify both at SessionStart.      │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Group C — Pattern lifecycle TTL (G-27)                          │
│  Each pattern carries last_fired + fired_count + optional       │
│  ttl_days override.                                             │
│  Model appends to pattern-firings.log per pattern application.  │
│  Dream's TTL phase reads log → batch-updates frontmatter →      │
│  truncates log → archives stale patterns (180d default).        │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
              policy-refusals.log         (pii-bypass entries)
              high-stakes-writes.log      (G-05 audit; new file)
              pattern-firings.log         (G-27 firing log; new file)
```

---

## 3. Group A — Write-time backstops

### 3.1 PII pattern backstop (G-02)

Extend `claude-code-hook.js --on-pre-tool-use` with a memory-write branch that lazy-loads `redact.js` patterns and refuses on match.

```js
// Existing path-block (auto-memory) check stays.

// NEW: PII scan on writes to user-data/memory/.
const memoryPrefix = join(REPO_ROOT, 'user-data/memory/');
if (target.startsWith(memoryPrefix)) {
  const content = event.tool_input?.content
                ?? event.tool_input?.new_string
                ?? '';
  const { applyRedaction } = await import('./lib/sync/redact.js');  // lazy
  const { redacted, count } = applyRedaction(content);
  if (count > 0) {
    const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
    appendPolicyRefusal(REPO_ROOT, {
      kind: 'pii-bypass',
      target,
      layer: 'write-hook',
      reason: `${count} PII pattern(s) detected`,
      contentHash: fnv1a(content),
    });
    process.stderr.write(
      `WRITE_REFUSED [pii]: ${count} PII pattern(s) detected in write to ${target}. ` +
      `Redact (e.g., replace SSN with [REDACTED:ssn]) before retrying.\n`
    );
    process.exit(2);
  }
}

// (High-stakes audit branch — see §3.2)

process.exit(0);
```

Lazy-import means non-memory-path writes (e.g., source-code edits) don't pay the redaction-pattern compilation cost. Per-call cost when triggered: O(content × pattern_count) ≈ <5ms typical, ~50ms on 50KB pastes.

### 3.2 High-stakes destination audit (G-05)

Same hook, additional check for writes to high-stakes paths. Audit-only (does not block).

```js
const HIGH_STAKES_DESTINATIONS = [
  'user-data/memory/tasks.md',
  'user-data/memory/decisions.md',
  'user-data/memory/self-improvement/corrections.md',
  'user-data/memory/self-improvement/patterns.md',
  'user-data/memory/self-improvement/preferences.md',
  'user-data/memory/self-improvement/communication-style.md',
  'user-data/memory/profile/identity.md',
];

if (HIGH_STAKES_DESTINATIONS.some(p => target.endsWith(p))) {
  const { appendHighStakesWrite } = await import('./lib/high-stakes-log.js');
  appendHighStakesWrite(REPO_ROOT, {
    target: relativeTarget(target),
    contentHash: fnv1a(content),
  });
  // Continue — write proceeds. Audit-only.
}
```

`appendHighStakesWrite` deduplicates: same `target+contentHash` within a 1-hour window → single entry. Avoids log spam during active editing.

`user-data/state/high-stakes-writes.log`:

```
timestamp \t target \t content-hash
2026-05-01T14:23Z   tasks.md                          a1b2c3d4
2026-05-01T15:01Z   decisions.md                      e5f6g7h8
2026-05-01T16:45Z   self-improvement/corrections.md   91a2b3c4
```

Distinct from `policy-refusals.log` so refusals (blocked attacks) don't get conflated with audits (informational events).

### 3.3 Morning-briefing surface (high-stakes)

`system/jobs/morning-briefing.md` adds a section:

```markdown
**High-stakes writes review.**
Read user-data/state/high-stakes-writes.log entries since last briefing cursor.
Aggregate by target. Output:

  Security: high-stakes writes (since last briefing)
    - tasks.md: 3 writes (latest 14:23Z)
    - decisions.md: 1 write (latest 09:11Z)
    - self-improvement/corrections.md: 2 writes (latest 16:45Z)

Ask Kevin if any look unintended; if so, investigate.
```

Cursor shared with cycle-1b/2b's policy-refusals review cursor — single "last reviewed at" timestamp covers all morning-briefing audit surfaces.

---

## 4. Group B — Integrity drift (manifest v2)

### 4.1 Manifest schema v2

```json
{
  "version": 2,
  "hooks": { ... },                // unchanged from v1
  "mcpServers": { ... },           // unchanged from v1
  "agentsmd": {
    "hardRulesHash": "",
    "lastSnapshot": ""
  },
  "userDataJobs": {
    "knownFiles": []
  }
}
```

Migration v1 → v2: handled by `check-manifest.js` on first read of a v1 manifest. Adds the new fields with empty values. Non-destructive.

### 4.2 AGENTS.md Hard Rules check (G-01)

```js
function checkAgentsMD(workspaceDir, expected) {
  const path = join(workspaceDir, 'AGENTS.md');
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const hardRules = extractSection(content, 'Hard Rules');
  if (!hardRules) {
    return { severity: 'severe', kind: 'agentsmd-hard-rules-missing',
             detail: 'Hard Rules section not found in AGENTS.md', hash: '' };
  }
  const currentHash = fnv1a(normalizeForHash(hardRules));
  if (!expected.agentsmd?.hardRulesHash) {
    // First-run baseline missing — info, not severe.
    return { severity: 'info', kind: 'agentsmd-hard-rules-baseline-missing',
             detail: 'Run manifest-snapshot.js to populate hardRulesHash', hash: currentHash };
  }
  if (expected.agentsmd.hardRulesHash !== currentHash) {
    return { severity: 'severe', kind: 'agentsmd-hard-rules-drift',
             detail: `Hard Rules hash mismatch (expected ${expected.agentsmd.hardRulesHash.slice(0,8)}…, got ${currentHash.slice(0,8)}…)`,
             hash: currentHash };
  }
  return null;
}

function extractSection(md, headerName) {
  // Require line-start anchor + exactly two `#`. Match until next `## `header or EOF.
  const re = new RegExp(`^##\\s+${headerName}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function normalizeForHash(text) {
  return text
    .split('\n')
    .map(line => line.trimEnd())              // strip trailing whitespace
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')               // collapse blank-line runs
    .trim();                                  // trim leading/trailing blanks
}
```

Normalization makes the hash semantically stable: cosmetic edits (whitespace, blank lines) don't trigger drift. Wording changes do.

`extractSection` requires `^##\s+Hard\s+Rules\b` — line-start, exactly two hashes, "Hard Rules" with optional trailing chars. Avoids false matches on prose mentions.

### 4.3 user-data/jobs drift (G-03)

```js
function checkUserDataJobs(workspaceDir, expected) {
  const dir = join(workspaceDir, 'user-data/jobs');
  if (!existsSync(dir)) return [];
  const current = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort();
  const known = new Set(expected.userDataJobs?.knownFiles ?? []);
  return current
    .filter(f => !known.has(f))
    .map(f => ({
      severity: 'mild',
      kind: 'unexpected-job-override',
      detail: `user-data/jobs/${f}`,
      hash: fnv1a(`job:${f}`),
    }));
}
```

New override files = mild drift. Same dedup applies (24h window). Triage same as cycle-2b's MCP triage: review, accept by adding to `userDataJobs.knownFiles`, commit.

### 4.4 `manifest-snapshot.js` extension

Snapshot helper extends to populate v2 fields:

```js
{
  version: 2,
  hooks: <current Claude Code hooks>,
  mcpServers: { expected: [...current MCPs], writeCapable: [] },
  agentsmd: {
    hardRulesHash: <computed from current AGENTS.md>,
    lastSnapshot: '<today>',
  },
  userDataJobs: {
    knownFiles: <current files in user-data/jobs/*.md>,
  },
}
```

Default mode (read-only): writes to stdout. `--apply --confirm-trust-current-state` overwrites `user-data/security/manifest.json`. Same two-flag pattern as cycle-2b.

### 4.5 First-run baseline UX

When `agentsmd.hardRulesHash` is empty after migration v1→v2:
- `check-manifest.js` returns `severity=info` (not severe). Logs to refusal log; does NOT emit stderr at session start.
- Morning briefing surfaces: "Security: AGENTS.md baseline missing — run `node system/scripts/manifest-snapshot.js` to populate."
- Once Kevin populates, subsequent sessions silent (matching hash) until intentional Hard Rules edit.

---

## 5. Group C — Pattern lifecycle TTL (G-27)

### 5.1 Pattern frontmatter additions

Each pattern in `user-data/memory/self-improvement/patterns.md` gets:

```yaml
---
name: tendency-to-hedge-financial
last_fired: 2026-04-30          # most recent date the pattern fired (set by Dream)
fired_count: 7                   # cumulative lifetime count (set by Dream)
ttl_days: 180                    # OPTIONAL — override default
created: 2025-11-02
---
```

`ttl_days` is optional; when present, overrides the global 180-day default for this pattern only. Some patterns may legitimately fire rarely but matter long-term — Kevin sets a higher `ttl_days` per-pattern.

### 5.2 Firing log (`pattern-firings.log`)

`user-data/state/pattern-firings.log` — append-only, truncate-on-Dream-success.

Format (TSV):
```
2026-05-01T14:23:11Z	tendency-to-hedge-financial
2026-05-01T15:42:55Z	prefers-direct-feedback
```

**Recommended write idiom (model)**: when applying a pattern, append via Bash:
```sh
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t<pattern-name>" >> user-data/state/pattern-firings.log
```

Single Bash call; not blocked by cycle-2a sensitive patterns (echo is not on the sensitive list, target is not under `secrets/`, no env dump). Cheaper than Edit on the patterns.md file (which would touch frontmatter every firing).

Alternative: model uses Write/Edit append. Either works.

### 5.3 Dream TTL phase

`system/jobs/dream.md` adds a phase (immediately after capture-routing, before any other writes):

```markdown
## Phase X — Pattern TTL maintenance

1. Read user-data/state/pattern-firings.log into a Map<pattern-name, [timestamps]>.
2. Read user-data/memory/self-improvement/patterns.md (existing pattern frontmatter).
3. For each active pattern:
   a. Compute new last_fired = max(existing last_fired, max(firings[name]) || existing).
   b. Compute fired_count_increment = firings[name]?.length ?? 0.
   c. Set new fired_count = existing fired_count + fired_count_increment.
   d. Update frontmatter atomically.
4. After all updates, truncate user-data/state/pattern-firings.log (write empty file).
5. For each active pattern:
   a. Compute ttl = pattern.ttl_days ?? 180.
   b. If today - last_fired > ttl days:
      - Move pattern to user-data/memory/self-improvement/patterns-archive.md.
      - Add archived_at: <today>, archived_reason: "TTL exceeded (last fired YYYY-MM-DD)".
6. Append summary to journal: "Dream: archived N patterns, updated M last_fired, fired_count incremented by total K firings."
```

### 5.4 Migration

`system/scripts/migrate-cycle-2c.js` (one-shot, runs once after deployment):
1. Reads `user-data/memory/self-improvement/patterns.md`.
2. For each pattern without `last_fired`: set to today.
3. For each pattern without `fired_count`: set to 0.
4. Writes back atomically.

Result: existing patterns get a fresh "last fired" baseline (today), so they don't auto-archive on first Dream run.

### 5.5 Patterns archive growth

`patterns-archive.md` is append-only. Grows over time. No internal retention policy in cycle-2c. If file exceeds reasonable size (>1MB), a future cycle adds rotation. Documented limitation.

---

## 6. AGENTS.md and `system/rules/security.md`

### 6.1 AGENTS.md change

Single line under Hard Rules (cycle-2c):

```markdown
- **Mechanical backstops.** PII patterns in writes to `user-data/memory/` block at the hook layer (G-02). High-stakes destination writes are audited (G-05). AGENTS.md Hard Rules and `user-data/jobs/` are integrity-checked at session start (G-01, G-03). Promoted patterns auto-archive after 180 days inactivity (G-27). See `system/rules/security.md`.
```

Cumulative AGENTS.md additions across all four security cycles: ~6 lines net.

### 6.2 AGENTS.md / capture-rules.md model instructions

In capture-rules.md (or wherever pattern application is documented), add:

```markdown
## Pattern application

When applying a learned pattern (recognizing its signal, executing its counter-action), append to `user-data/state/pattern-firings.log`:

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t<pattern-name>" >> user-data/state/pattern-firings.log

Single Bash call. Dream batches updates to pattern frontmatter (last_fired, fired_count) and truncates the log on success. Skipping the append is not a security violation but causes pattern to drift toward TTL archive.
```

### 6.3 `system/rules/security.md` extensions

- PII backstop reference (write-hook, redact.js patterns reused).
- High-stakes destination list (the 7 paths) + audit log + morning-briefing surface.
- Manifest schema v2 reference: `agentsmd.hardRulesHash` and `userDataJobs.knownFiles`.
- Hash normalization rules (whitespace stable; semantic-only drift).
- AGENTS.md Hard Rules baseline workflow (Walkthrough A below).
- AGENTS.md Hard Rules edit workflow (Walkthrough B below).
- user-data/jobs override workflow (Walkthrough D below).
- Pattern firing flow and TTL semantics (Walkthrough C below).
- Known limitations: archive growth unbounded; ttl_days override; pattern-firings model-instruction residual.

Estimated addition: ~80 lines.

---

## 7. Worked walkthroughs

### 7.1 Walkthrough A — AGENTS.md Hard Rules baseline (first cycle-2c session)

```sh
# 1. Cycle-2c lands. Migration auto-bumps manifest to v2; agentsmd.hardRulesHash empty.

# 2. First session start: check-manifest.js logs info entry:
#    "agentsmd-hard-rules-baseline-missing — run manifest-snapshot.js"

# 3. Morning briefing surfaces the same line.

# 4. Kevin baselines:
node system/scripts/manifest-snapshot.js > /tmp/snap.json

# 5. Diff and copy:
diff user-data/security/manifest.json /tmp/snap.json
$EDITOR user-data/security/manifest.json
# Add agentsmd.hardRulesHash from /tmp/snap.json

# 6. Verify:
node system/scripts/check-manifest.js
# Silent (no drift, baseline matches).
```

### 7.2 Walkthrough B — AGENTS.md Hard Rules legitimate edit

```sh
# 1. Kevin edits Privacy hard rule wording.
$EDITOR AGENTS.md

# 2. Next session start:
#    TAMPER DRIFT [severe]: agentsmd-hard-rules-drift — Hard Rules hash mismatch
#    (visible in model context; Robin's reply mentions it)

# 3. Re-baseline:
node system/scripts/manifest-snapshot.js > /tmp/snap.json
$EDITOR user-data/security/manifest.json
# update agentsmd.hardRulesHash with new value
# update agentsmd.lastSnapshot to today
```

### 7.3 Walkthrough C — Pattern firing flow

```
Session 1 — pattern P1 fires:
  - Model recognizes signal, applies counter-action.
  - Model: echo "..." >> user-data/state/pattern-firings.log

Session 2 — P1 fires again, plus P2.
  - Two more lines in pattern-firings.log.

Dream runs (next day) — Phase X:
  - Reads pattern-firings.log.
  - Groups by pattern-name. P1: 2 firings, latest today. P2: 1 firing.
  - Updates patterns.md frontmatter:
      P1: last_fired=today, fired_count += 2
      P2: last_fired=today, fired_count += 1
  - Truncates pattern-firings.log.
  - Checks all patterns for TTL: any with (today - last_fired) > ttl_days → archive.
  - Appends one summary line to journal.
```

### 7.4 Walkthrough D — `user-data/jobs/` override workflow

Same flow as cycle-2b's MCP triage (mild drift; Kevin reviews, accepts via manifest edit). See cycle-2b spec §7.2 for the canonical example. Cycle-2c reuses the pattern verbatim — only the manifest field name differs (`userDataJobs.knownFiles` instead of `mcpServers.expected`).

---

## 8. Refusal log evolution (cycle-2b → cycle-2c)

`policy-refusals.log` schema unchanged. New `kind=pii-bypass` entries from Group A.

`high-stakes-writes.log` is a new file with simpler schema (`timestamp \t target \t content-hash`) — only target + content-hash needed, no severity or layer. Distinct from refusals (audit, not block).

`pattern-firings.log` is a new file written by the model (Bash echo) and read+truncated by Dream. Format: `timestamp \t pattern-name`.

---

## 9. Tests

### 9.1 Unit (deterministic)

`system/tests/security/`:
- `pii-write-hook.test.js` — synthetic Write event with SSN in content; hook exits 2 with `pii-bypass` log. Negative: write without PII passes (exit 0). Edge: write to non-memory path with PII content allowed.
- `high-stakes-audit.test.js` — write to `decisions.md` logs `high-stakes-writes.log`; allows. Dedup: same target+contentHash within 1h → single entry.
- `extract-section.test.js` — section extraction handles edge cases: last section in file, missing section, mixed-level headers (H1/H3 don't match), empty section, multi-paragraph section.
- `hash-normalize.test.js` — normalization stable: trailing whitespace, blank-line runs, leading/trailing blanks all produce same hash. Semantic edits produce different hash.
- `agentsmd-hash.test.js` — synthetic AGENTS.md → extract Hard Rules → hash. Whitespace edits → same hash. Wording changes → different hash. Missing section → null + severe drift.
- `userdata-jobs-drift.test.js` — synthetic dir + manifest combos: no drift, mild drift on new file, info on removed file (no entry).
- `manifest-v1-to-v2.test.js` — v1 manifest read by check-manifest → auto-migrated to v2 with empty agentsmd + userDataJobs fields. Idempotent.
- `pattern-ttl.test.js` — patterns with various last_fired/ttl_days combos: under TTL → keep, over TTL → archive. Per-pattern ttl_days override respected.
- `pattern-firings-log.test.js` — append; Dream truncate-on-success simulation; accumulation when Dream skips; batch-update logic computes correct new fired_count and last_fired.

### 9.2 Acceptance (mechanical)

- `s8-jailbreak-pii-write.test.js` — synthetic Write with SSN in content (model-jailbreak simulation); hook blocks; refusal logged; existing file unchanged.

### 9.3 Smoke (manual)

1. Edit AGENTS.md Hard Rules; observe SessionStart drift surfaces severe entry; baseline; verify silent.
2. Drop a fake `user-data/jobs/foo.md`; observe mild drift entry next session; add to manifest; verify silent.
3. Synthetic pattern with `last_fired: <200 days ago>`; run Dream TTL pass; pattern moved to archive.
4. Synthetic Write tool call with SSN; observe block + refusal log entry.
5. Append synthetic line to `pattern-firings.log`; run Dream; verify pattern's frontmatter updated, log truncated.
6. Write to `tasks.md` 3 times within 1 hour with same content hash; observe 1 entry in `high-stakes-writes.log`. Different content → 3 entries.

---

## 10. Migration

1. **Order**: deploys after cycle-2b (extends manifest schema v1 → v2; `policy-refusals.log` from cycle-2a).
2. **Manifest v1 → v2**: `check-manifest.js` auto-migrates on first read (adds empty `agentsmd` + `userDataJobs` fields).
3. **Pattern frontmatter**: `migrate-cycle-2c.js` walks `patterns.md`, adds `last_fired: <today>` and `fired_count: 0` to each pattern. One-shot; rerunnable (idempotent — only adds missing fields).
4. **First post-deployment session**:
   - `agentsmd.hardRulesHash` empty → info entry; morning briefing prompts baseline.
   - `userDataJobs.knownFiles` empty → mild drift for every existing override; bootstrap by `manifest-snapshot.js` (per cycle-2b walkthrough D).
   - PII backstop active immediately on hook reload.
   - High-stakes audit active immediately.
   - Pattern TTL inactive until next Dream run (then begins).
5. **No data migration** for existing logs.

---

## 11. Risk register

| Risk | Mitigation |
|---|---|
| PII backstop false positive (Kevin's own SSN in journal he's editing) | Block-and-explain; model retries with `[REDACTED:ssn]`. Same UX as cycle-1a redaction. Acceptable. |
| Hard Rules hash brittleness on cosmetic edits | `normalizeForHash` strips trailing whitespace and collapses blank lines. Stable against cosmetic; tracks semantic. |
| AGENTS.md Hard Rules header format variation (`# Hard Rules`, `### Hard Rules`) | Regex requires line-start + exactly two `#`. Falls into "section missing" path → severe drift, prompts re-baseline. |
| `last_fired` not updated (jailbroken model skips log append) | Pattern drifts to archive after 180 days. Acceptable: pattern-loss is preferable to pattern-survival from a jailbroken session. Kevin can manually restore. |
| Pattern-firings log writes race in concurrent sessions | Append-mode atomic at OS level. No race. |
| `pattern-firings.log` accumulates if Dream fails | Self-healing: next successful Dream catches up. Disk usage bounded by Dream cadence. |
| `patterns-archive.md` grows unbounded | Documented limitation. Future cycle if needed. |
| `userDataJobs.knownFiles` mass drift on first deploy | One-time triage via `manifest-snapshot.js --apply --confirm-trust-current-state` (per cycle-2b pattern). |
| `high-stakes-writes.log` spam during heavy editing | Dedup within 1h on `target+contentHash`. |
| AGENTS.md baseline fishing — attacker edits Hard Rules + manifest hash together | Same residual as cycle-2b: detection layer is git diff review on pull. Documented. |
| `extractSection` matches wrong section if duplicate header | Regex matches first occurrence. Document: AGENTS.md must have at most one `## Hard Rules` section. Test. |
| Other agent's `feat/a3-session-end-sweep` work has touched AGENTS.md Hard Rules | Re-read AGENTS.md before edits. Hash baseline taken AFTER all other-agent merges. |

---

## 12. Time budget

- **Target:** 1 working day.
- **Ceiling:** 2 working days.
- **Per-component:**
  - PII backstop hook extension + test: 1h
  - High-stakes audit log + helper + dedup + test: 1h
  - `extract-section` + `normalizeForHash` + tests: 0.75h
  - AGENTS.md hash check + `agentsmd-hash` test: 0.75h
  - User-data/jobs drift check + test: 0.5h
  - Manifest v1→v2 migration logic + test: 0.5h
  - `manifest-snapshot.js` v2 extension: 0.5h
  - Pattern frontmatter migration script: 0.5h
  - Pattern firings log helper + Bash idiom: 0.25h
  - Dream TTL phase + protocol update + test: 1.5h
  - `pattern-ttl.js` config + per-pattern override + test: 0.5h
  - Acceptance test S8: 0.75h
  - AGENTS.md + `system/rules/security.md` updates: 1h
  - Walkthroughs in security-rules.md: 0.5h
  - Smoke + cleanup: 0.5h

---

## 13. Definition of done

1. PII backstop in `claude-code-hook.js --on-pre-tool-use` blocks writes to `user-data/memory/` containing PII patterns. Refusal logged with `kind=pii-bypass`.
2. High-stakes destinations write to `user-data/state/high-stakes-writes.log` with 1h dedup; allow the underlying write.
3. Manifest schema v2: auto-migration from v1; `agentsmd.hardRulesHash` and `userDataJobs.knownFiles` present (empty until baselined).
4. `check-manifest.js` checks AGENTS.md Hard Rules hash + user-data/jobs drift; baseline-missing → info; mismatch → severe.
5. `extractSection` handles edge cases per unit tests.
6. `normalizeForHash` produces hash-stable output for cosmetic edits.
7. `manifest-snapshot.js` extended to dump v2 fields including computed `hardRulesHash` and current `userDataJobs.knownFiles`.
8. Patterns gain `last_fired` + `fired_count` frontmatter; `migrate-cycle-2c.js` seeds existing patterns; per-pattern `ttl_days` override supported.
9. AGENTS.md / capture-rules.md instruct model to append to `pattern-firings.log` on application via Bash echo idiom.
10. Dream TTL phase: reads firings log, batch-updates patterns.md frontmatter (last_fired + fired_count), truncates log, archives patterns over TTL, appends journal summary.
11. AGENTS.md gains 1-line backstops rule. `system/rules/security.md` extended with cycle-2c walkthroughs A/B/C/D and limitations.
12. Morning-briefing protocol surfaces high-stakes-writes summary aggregated by destination.
13. S8 acceptance test passes.
14. Existing test suite green.
15. Zero confirm prompts.

---

## 14. Cumulative gap-closure matrix (all five cycles)

Snapshot at cycle-2c sign-off. Maps each audit gap to closing mechanism + verifiable artifact.

| Gap | Sev | Cycle | Mechanism | Verifiable artifact |
|---|---|---|---|---|
| G-01 | M | 2c | AGENTS.md Hard Rules hash check | `check-manifest.js:checkAgentsMD`; `manifest.json:agentsmd.hardRulesHash` |
| G-02 | M | 2c | PreToolUse hook PII scan on memory writes | `claude-code-hook.js --on-pre-tool-use` (memory branch) |
| G-03 | H | 2c | user-data/jobs drift at SessionStart | `check-manifest.js:checkUserDataJobs`; `manifest.json:userDataJobs.knownFiles` |
| G-04 | H | 1a | Origin gate on direct-write exceptions | `capture-rules.md`; `dream-pre-filter.js` |
| G-05 | M | 2c | High-stakes destination audit log | `claude-code-hook.js`; `high-stakes-writes.log` |
| G-06 | C | 1a | trust:untrusted markers + sanitization on synced files | `markdown.js:atomicWrite` |
| G-07 | H | 1a | Sender display-name sanitization | `sanitize-tags.js` |
| G-08 | H | 1a | Subject + snippet sanitization + markers | `sync-gmail.js`; `atomicWrite` |
| G-09 | C | 1a | sync-github writes get markers | `sync-github.js`; `atomicWrite` |
| G-10 | C | 1b | Outbound-policy taint check | `outbound-policy.js` (layer 1) |
| G-11 | C | 1a | Calendar markers + sanitization | `sync-calendar.js`; `atomicWrite` |
| G-12 | H | 1a | Calendar title in marked content | `sync-calendar.js`; `atomicWrite` |
| G-13 | M | 1a (side-effect) | sync-lunch-money writes get markers | `sync-lunch-money.js`; `atomicWrite` |
| G-14 | L | won't-fix | Acknowledged | n/a |
| G-15 | C | 1a | Ingest destination blocklist | `ingest-guard.js`; `system/jobs/ingest.md` |
| G-16 | C | 1a | Ingest source pages get markers | `system/jobs/ingest.md`; `atomicWrite` |
| G-17 | H | 1a | Multi-file ripple constrained | `ingest-guard.js` |
| G-18 | C | 1b | Outbound content gates | `outbound-policy.js` |
| G-19 | H | 1b | Target allowlist (PAT scope) | `outbound-policy.js` (layer 3) |
| G-20 | L | future | spotify-write low-risk | n/a |
| G-21 | C | 1b | discord-bot reply gated | `discord-bot.js` subprocess wrapper |
| G-22 | H | 2a | Lazy-read secrets | `secrets.js`; `safe-env.js` |
| G-23 | C | 1a | Origin tagging + Dream pre-filter | `dream-pre-filter.js`; AGENTS.md |
| G-24 | C | 1a | Same as G-23 | same |
| G-25 | C | 1a | sanitize-tags on sync | `sanitize-tags.js` |
| G-26 | C | 1a (side-effect) | Sync-origin captures quarantined; pattern threshold not reachable | `dream-pre-filter.js` |
| G-27 | H | 2c | Pattern TTL: 180-day inactivity → archive | `pattern-ttl.js`; Dream Phase X |
| G-28 | H | 2b | Hook drift detection | `check-manifest.js`; `manifest.json:hooks` |
| G-29 | H | 2a | Bash hook + sensitive patterns | `claude-code-hook.js --on-pre-bash`; `bash-sensitive-patterns.js` |
| G-30 | M | 2a | PreToolUse extended to Bash | `.claude/settings.json` |
| G-31 | H | hotfix | chmod 0600 enforced | `secrets.js` (commit `ea3849d`) |
| G-32 | H | 2a | Same root + spawn-time scrub | `secrets.js`; `safe-env.js`; spawn sites |
| G-33 | M | future | At-rest encryption deferred | n/a |
| G-34 | M | future | Audit trail of secret reads deferred | n/a |
| G-35 | M | future | npm install hardening deferred | n/a |
| G-36 | L | future | Lockfile review automation deferred | n/a |
| G-37 | M | 2b | MCP server allowlist via manifest | `check-manifest.js`; `manifest.json:mcpServers` |
| G-38 | M | future | Per-MCP write capability tracking deferred | n/a |
| G-39 | L | hotfix | Verified — bot config correct | n/a |
| G-40 | L | future | sessions.md signing deferred | n/a |
| G-41 | L | future | Spec force-add discipline deferred | n/a |
| G-42 | M | future | Backup encryption (subset of G-33) | n/a |

**Summary** (matches audit's 42 gaps with 12C/13H/11M/6L):

| Disposition | Count | C/H/M/L |
|---|---|---|
| Closed (directly via cycles) | 28 | 11 / 12 / 5 / 0 |
| Side-effect closed (cycle-1a) | 2 | 1 / 0 / 1 / 0 |
| Hotfixed (already shipped) | 2 | 0 / 1 / 0 / 1 |
| Won't-fix (acknowledged) | 1 | 0 / 0 / 0 / 1 |
| Future | 9 | 0 / 0 / 5 / 4 |

---

## 15. Hand-off

Cycle-2c is the last spec for the audit's mapped gaps. After sign-off:
- Re-audit triggered when next material change occurs (new sync source, new outbound tool, new threat tier — per audit re-cadence).
- Future gaps (the 9 deferred items) become input to a future cycle when prioritized.
- Cumulative architecture documented across cycle-1a/1b/2a/2b/2c specs; this spec's §14 is the single-pane verification matrix.

---

## 16. Coupling note (other-agent collision)

At spec-write time, the other agent's `feat/a3-session-end-sweep` branch is active. Coupling concerns for cycle-2c implementation:

- **AGENTS.md Hard Rules**: other agent edited Hard Rules and adjacent sections. Re-read before edits. Hash baseline taken AFTER all other-agent work merges.
- **`claude-code-hook.js --on-pre-tool-use`**: other agent didn't touch (their work was Stop-mode); cycle-2c extends pre-tool-use. Low conflict.
- **`system/jobs/dream.md`**: cycle-2c adds a TTL phase. Other agent's work is on session-end / Stop hook; Dream protocol unchanged by them. Low conflict but verify.
- **`system/jobs/morning-briefing.md`**: cycle-2c adds high-stakes-writes review. Other agent's work was on Session End; not morning briefing. Low conflict but verify.
- **`system/scripts/migrate/apply.js`**: cycle-2c adds `migrate-cycle-2c.js` as a one-shot; doesn't touch existing migration system. Low conflict.

Implementation paused until user greenlights. Re-read all five coupling notes (cycles 1a/1b/2a/2b/2c) when resuming.

---

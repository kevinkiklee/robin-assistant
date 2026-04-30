# Robin Security Audit — Design Spec

**Date:** 2026-04-30
**Author:** Kevin (with Claude)
**Status:** Draft — implementation authorized
**Scope:** Design for a point-in-time security/privacy/prompt-injection audit of `robin-assistant/` (CLI npm package + Kevin's live `user-data/`). The audit is the first of three sequenced cycles: **(3) audit → (1) prompt-injection-on-sync defenses → (2) privacy hardening**.

This document is the spec. The audit deliverable it produces lives at `docs/security/audit-2026-04-30.md`.

**Storage policy.** `docs/` is gitignored by default ("Internal design notes — local-only" per `.gitignore`). Specs are force-added to git per existing convention (every prior design spec is in history). **The audit deliverable itself is NOT force-added** — it stays local. Literal references to `user-data/` content in the audit are acceptable because the file doesn't leave Kevin's machine. If the audit is ever published or forked into a public location, it requires a redaction pass first; that's a future concern.

---

## 1. Goals & non-goals

### Goals
- Produce a snapshot threat model for Robin as it stands on 2026-04-30.
- Enumerate the attack surface, current defenses, and gaps — with confidence-tagged evidence.
- Walk 10 named attack scenarios end-to-end, each producing a falsifiable acceptance criterion that becomes a test in cycle-1 or cycle-2.
- Produce a prioritized gap list that drives the next two cycles' brainstorms.
- Stay within a 1-day target / 2-day ceiling.

### Non-goals
- Live red-teaming / penetration testing of the running system.
- Auditing `robin-assistant-app/`, `robin-cursor/`, `robin-gemini/`, or other workspace projects.
- Auditing MCP server internals (we audit our trust assumption *of* them, not their code).
- A polished public-facing security document. Audience is internal — Kevin and future-Claude.
- Prescribing fixes. The audit identifies; cycles 1 and 2 prescribe and implement.

### Constraints
- Audit deliverable is local-only (gitignored under `docs/`). Spec is force-added to git per convention.
- Read-the-code is the primary method. Bounded empirical checks (REPL-only, no network, no live writes) are allowed where redaction or pattern-matching behavior must be confirmed.
- Critical gaps require `[verified]` confidence to enter cycle-1's input set.

---

## 2. Audit structure

The deliverable file follows this section layout. Section bodies use the templates in §5.

```
§1 Threat Model
  1.1 Actors and capabilities (T1–T4)
  1.2 Assets
  1.3 Trust boundaries (with diagram)
  1.4 Assumptions
  1.5 Non-goals (what we won't defend against)

§2 Surface Inventory  (17 subsections)

§3 Attack Scenarios   (10 subsections)
  3.5 Observations    (non-gap notes)

§4 Gap List
  4.1 Table (ID | Surface | Severity | Description | Effort | Linked-scenarios | Goes-to)
  4.2 Cycle weighting

§5 Out of Scope

§6 Sign-off
```

### Frontmatter

```yaml
---
description: Robin security/privacy/prompt-injection audit, snapshot dated 2026-04-30
type: audit
date: 2026-04-30
audience: internal
status: draft | signed-off
follow-ups: []   # filled when cycle-1 / cycle-2 specs land
---
```

---

## 3. Threat model

### 3.1 Threat actors (all four tiers in scope)

| Tier | Actor | Capabilities | Goal |
|---|---|---|---|
| **T1** | Remote content adversary | Can email Kevin, post to public GitHub repos, send Discord messages, send calendar invites, host webpages he ingests, publish Letterboxd reviews. No code execution, no system access. | Plant content that, when ingested or synced, alters Robin's behavior or exfiltrates data via Robin's outbound tools. |
| **T2** | Supply-chain adversary | Compromise an npm dep, an MCP server, a Claude Code plugin, or a fork's hooks. Code execution at install or runtime. | Steal secrets, persist a backdoor, exfiltrate memory. |
| **T3** | Local-host adversary | Shell access to Kevin's Mac (housemate, lost laptop, malware). | Read `secrets/.env`, read `user-data/`, pivot. |
| **T4** | Insider / self / model jailbreak | Kevin himself (accidental disclosure) or a model-level jailbreak that bypasses AGENTS.md rules in a single session. | Accidental leakage; rule-bypass. |

### 3.2 T1 attacker baseline (assumed knowledge)

T1 knows Kevin's public email (`iser3000@gmail.com`), can post to public GitHub repos, can find Letterboxd public exports, can guess shape of memory layout from the public repo. T1 does **not** know which integrations Kevin has enabled, his secrets, his calendar, or any specific knowledge file's contents.

### 3.3 Assets

- **Memory.** `user-data/memory/` — facts, decisions, tasks, finance, health, journal, profile.
- **Secrets.** `secrets/.env` — OAuth refresh tokens, API keys, Discord bot token.
- **Capability to act.** Outbound write tools — github-write, spotify-write, discord-bot — can affect the world on Kevin's behalf.
- **Trust in agent behavior.** Kevin acting on Robin's outputs (financial decisions, task completions).

### 3.4 Trust boundaries (diagram)

```
[external source]                              T1 boundary
       │
       ▼
[sync script]  ── applies redact?  ── ▶  [knowledge file]
                                                │
                                                ▼ load at session start
                                          [model context]
                                          /     │      \
                                         ▼      ▼       ▼
                              [agent reply]  [tool call]  [capture → inbox.md]
                                            │
                                            ▼
                                      [outbound action]      T1 → T1 amplification
```

Each arrow is a trust boundary. The capture-loop edge (`[model context] → [inbox.md]`) is the system's central injection-amplification path: untrusted content in context can mirror itself into permanent memory.

### 3.5 Assumptions

- FileVault is on; physical theft is post-boot only.
- `~/.claude/` plugins and MCP servers Kevin has installed are trusted (their compromise is a T2 finding, not an assumption violation).
- The npm registry is trusted at the moment of install; supply-chain compromise is a T2 finding.
- Publishing this threat model educates attackers as much as defenders. We accept transparency over obscurity.

---

## 4. Surface inventory (17 surfaces in scope)

| # | Surface | Group |
|---|---|---|
| 1 | AGENTS.md / CLAUDE.md / GEMINI.md | Prompt context |
| 2 | `system/jobs/*.md` (protocols) | Prompt context |
| 3 | `system/capture-rules.md` | Prompt context |
| 4 | sync-gmail | Sync inputs |
| 5 | sync-github | Sync inputs |
| 6 | sync-calendar | Sync inputs |
| 7 | sync-lunch-money | Sync inputs |
| 8 | sync-spotify | Sync inputs |
| 9 | ingest + Letterboxd import | Sync inputs |
| 10 | github-write | Outbound write |
| 11 | spotify-write | Outbound write |
| 12 | discord-bot | Outbound write |
| 13 | Capture loop (inbox writes) | Memory writes |
| 14 | Self-improvement loop | Memory writes |
| 15 | Hooks (`.claude/settings.json`, install-hooks.js, pre-commit-hook.js, claude-code-hook.js) | Hooks |
| 16 | Secrets (`secrets/.env`, file modes, env reads) | Secrets |
| 17 | Install/update + MCP enumeration + scheduled execution (launchd) + multi-host coordination + git/gitignore + backups | Composite (low-individual-risk surfaces consolidated) |

Each surface gets a §2 subsection following the template in §5.1.

---

## 5. Section templates

### 5.1 §2 surface entry template

```markdown
### 2.N Surface: <name>

**Inputs.** What flows in. <one or two sentences>
**Controller of inputs.** Who supplies them (specific external actor, aggregate-many, system-only).
**Mutability.** One-shot | Persistent. With duration.
**Sanitization.** What runs on ingress. Cite file:line. Tag confidence.
**Current defenses.** Bullet list. Each cites file:line and tags `[verified|likely|guess]`. If none: literally write **"No current defenses."**
**Gaps.** Bullet list. Each links a gap ID (`G-NN`) and ≥1 scenario (`S-N`) where applicable.
**Concrete example.** One example from live `user-data/`. Must be `[verified]` (we read the file). Quote a path and a short literal snippet only when it adds explanatory value; otherwise paraphrase. The audit is local-only, so this is a clarity preference, not a redaction requirement.
**Notes.** Anything else.
```

### 5.2 §3 scenario template

```markdown
### S<N>: <short name>

**Threat tier.** T1 | T2 | T3 | T4
**Surfaces crossed.** A → B → C
**Walkthrough.**
1. Step 1, citing `file_path:line` where applicable. `[verified|likely|guess]`
2. Step 2 ...
3. ...
**Falsifiability.** Mechanically evaluable acceptance test — regex, file-content match, boolean check on output. Becomes a cycle-1 (or cycle-2) regression test. **No `[guess]` steps allowed in a published scenario.**
**Linked gaps.** G-NN, G-NN, ...
```

### 5.3 §4 gap-list table

```
| ID    | Surface         | Severity | Description (1-4 lines + `Refs:` line) | Effort | Linked-scenarios | Goes-to     |
| G-01  | sync-gmail      | Critical | ...                                    | M      | S1, S5           | cycle-1     |
```

`Goes-to`: `cycle-1` | `cycle-2` | `future` | `won't-fix` (with reason) | `hotfix-now` (Critical with trivial fix; addressed inline before audit signs off).

### 5.4 §4.2 cycle-weighting table

```
| Goes-to     | Count | Severities (C/H/M/L) |
| cycle-1     | <n>   | <n>/<n>/<n>/<n>      |
| cycle-2     | <n>   | <n>/<n>/<n>/<n>      |
| future      | <n>   | <n>/<n>/<n>/<n>      |
| hotfix-now  | <n>   | <n>/<n>/<n>/<n>      |
| won't-fix   | <n>   | <n>/<n>/<n>/<n>      |
```

If `cycle-1` row Critical+High count exceeds 8, split cycle-1 into 1a/1b before its brainstorm.

---

## 6. Severity rubric

| Tag | Definition |
|---|---|
| **Critical** | Realistic remote attack (T1 or T2 baseline), current defenses don't stop it, blast radius is persistent. |
| **High** | Realistic remote attack, partial defense exists, exploitable with moderate effort or specific conditions. |
| **Medium** | Multiple-step or narrower preconditions, or T3/T4 actor. Real but bounded. |
| **Low** | Defense-in-depth / hardening. No known exploitable failure. |
| **Info** | Documentation, naming, or assumption gap. Not a flaw — clarity issue. |

**Rules:**
- **Persistence multiplier.** A finding whose impact persists across sessions (memory poisoning, planted patterns, secrets stored insecurely) bumps one tier up from its transient equivalent.
- **Rollback cost as tiebreaker.** Between two findings of equal severity, the one harder to roll back ranks higher in the gap list.
- **Critical reachability.** Only T1 and T2 attacks can reach **Critical**. T3 and T4 findings cap at **High** regardless of impact, since they require local-host or insider access we already partially defend against by assumption.
- **`[verified]` requirement for Critical.** A provisional Critical that is only `[likely]` is downgraded to **High** with a `verify-in-cycle-1` note. Critical means `[verified]` Critical, full stop.

---

## 7. Attack scenarios — shortlist (10)

Each gets a §3 entry. ID stable across cycles.

| # | Name | Tier | Surfaces |
|---|---|---|---|
| S1 | Email-borne prompt injection → exfil via discord-bot | T1 | sync-gmail, capture loop, discord-bot |
| S2 | Calendar-invite injection → tasks.md poisoning | T1 | sync-calendar, capture loop, prompt context |
| S3 | Letterboxd export with hidden instructions → ingest poisons knowledge | T1 | ingest, artifacts/input, memory writes |
| S4 | GitHub-issue injection → exfil via github-write (issue comment) | T1 | sync-github, github-write |
| S5 | Self-improvement poisoning: 3+ correction-shaped emails → permanent rule planted | T1 | sync-gmail, self-improvement, capture loop |
| S6 | Compromised npm dep at install reads secrets/.env | T2 | install/update, secrets |
| S7 | Lost/unattended laptop without FileVault → secrets + memory plaintext | T3 | secrets, file modes |
| S8 | Single-session model jailbreak bypasses AGENTS.md privacy rule | T4 | prompt context, capture loop, memory writes |
| S9 | Compromised MCP server logs every tool argument | T2 | MCP enumeration, secrets |
| S10 | Hook tampering: malicious `.claude/settings.json` from a fork runs attacker code per tool call | T2 | hooks, install/update |

---

## 8. Method

**Primary method: read-the-code, plus bounded empirical checks.**

Empirical checks allowed:
- Pure-function REPL: feed strings to `applyRedaction()`, regex matchers, parsers.
- File-state inspection: `stat`, `git check-ignore`, `launchctl list`, file-mode reads.
- Tool inventory: parse `.mcp.json`, `.claude/settings.json`, `package.json`.

Empirical checks NOT allowed in this audit (escalate to cycle-1's test plan):
- Sending live network requests.
- Writing live data through any sync, write, or hook script.
- Modifying memory, secrets, or running protocols against real integrations.

**Confidence tags** (per AGENTS.md "Cite + Confidence"):
- `[verified]` — read the actual code or ran a bounded check and confirmed.
- `[likely]` — inferred from a clear pattern; high confidence but didn't read every call site.
- `[guess]` — pattern-match only; flagged for follow-up.

**Promotion rules:**
- Critical gaps must be `[verified]`. A finding that is provisionally Critical but only `[likely]` is recorded as **High** with a `verify-in-cycle-1` note; cycle-1's plan picks up the verification work.
- Scenario steps must be `[verified]` or `[likely]`. **No `[guess]` steps in a published scenario.** Model-behavior steps default to `[likely]`; `[verified]` claims about model behavior require a transcript citation.
- `[guess]` findings of any severity stay in §3.5 Observations until they're upgraded by further reading.

**Defense-found-mid-audit.** If a defense exists that we initially missed, the gap drops from §4 and the defense gets recorded in §2 with a `[verified]` tag.

---

## 9. Tooling pass (run during audit; outputs quoted inline in §2 with `[verified]`)

| Check | Approach |
|---|---|
| Gitignore enforcement | `git check-ignore` on `secrets/`, `user-data/`, `.env` |
| File modes on secrets | `stat secrets/.env`, `secrets/` dir |
| Hardcoded paths/creds | `grep -r ~/.ssh`, `bearer`, hex API-key shapes |
| MCP server enumeration | parse `.mcp.json` and Claude settings |
| Postinstall behavior | read `package.json` postinstall, trace |
| Hook execution paths | inventory `.claude/settings.json` hooks |
| Hook command-injection grep | search hook scripts for shell exec on untrusted input |
| Redaction call-site coverage | `grep -r applyRedaction` mapped against all write paths |
| Sync trust gates | per sync-*: where do untrusted bytes touch FS? |
| `npm audit` snapshot | run, save full output |
| `process.env` reads | grep all env-var consumers |
| Outbound HTTP destinations | grep `fetch`/`axios`/`http.request` |
| launchd/cron entries | `launchctl list \| grep robin` |
| Capture-rules direct-write exceptions | re-read `system/capture-rules.md`, list all |
| `validate-host.js` coverage | read, list which rules it actually exercises |
| Code SHA pin | `git rev-parse HEAD` recorded in audit §0 (Method header) |

---

## 10. Pre-flight checklist

Before writing any audit content:

- [ ] `git status` clean on `system/`, `bin/`, `.claude/`. No local hook tampering, no in-flight changes that would stale `[verified]` claims.
- [ ] Latest sync runs completed — `user-data/state/jobs/INDEX.md` shows recent timestamps for all enabled syncs.
- [ ] `docs/security/` directory created; verify it's gitignored (`git check-ignore docs/security/audit-2026-04-30.md`).
- [ ] Pin: record `git rev-parse HEAD` in audit §0 (Method). All code-citing findings reference this SHA.
- [ ] `npm audit` output saved into the audit body (under §2 surface 17).

---

## 11. Risk register for the audit work itself

| Risk | Mitigation |
|---|---|
| Audit scope-creeps past 2-day ceiling | Hard timebox per surface (~30 min). Overruns become `future` findings. |
| Too many Criticals overwhelm cycle-1 | §4.2 weighting table makes this visible. If cycle-1 Critical+High > 8, split 1a/1b. |
| `[guess]` findings get promoted to action | Critical needs `[verified]` to enter cycle-1. Verification work logged in cycle-1's plan, not this audit. |
| Audit ever leaves Kevin's machine (e.g., accidentally force-added, included in a fork) | Audit lives under `docs/` (gitignored). `git status` check at sign-off confirms the audit file is not staged. If the audit is ever to be published, a redaction pass is required first — flagged as a future concern, not handled in this cycle. |
| Mid-audit code change invalidates findings | Pin `git rev-parse HEAD` in audit §0; all code-citing findings reference this SHA. |
| Auditor (me/Claude) misses a defense and overstates a gap | Defense-found-mid-audit rule: gap drops, §2 records the defense. Welcome and expected. |

---

## 12. Definition of done

The audit is done when **all** of:

1. All 17 surfaces in §2 have a populated subsection (inputs, controller, mutability, sanitization, current defenses, gaps, concrete example, notes). No `TBD`.
2. All 10 scenarios in §3 are written end-to-end. Each has a mechanically evaluable falsifiability statement. No `[guess]` steps.
3. Every Critical gap in §4 has at least one linked scenario.
4. Every Critical gap is `[verified]` and assigned to `cycle-1`, `cycle-2`, or `hotfix-now`. (Not `future`. Not `won't-fix` without explicit reason.)
5. Every High gap is assigned, OR has an explicit one-line deferral note.
6. §1.4 trust-boundary diagram drawn.
7. §1.5 non-goals and §5 out-of-scope are non-empty and consistent (no surface in §5 also claimed in-scope by §1).
8. §4.2 cycle-weighting table populated.
9. Audit §0 (Method header) records the pinned `git rev-parse HEAD` SHA.
10. `git status` at sign-off shows the audit file is NOT staged (it stays local).
11. Kevin signs off in §6.

---

## 13. Hand-off to cycle-1

When the audit signs off:

- The audit's file path **and the commit SHA at sign-off** are named explicitly in cycle-1's spec frontmatter (`source-audit:`).
- Cycle-1's brainstorm starts from the gap IDs tagged `goes-to: cycle-1`. It does not re-derive threats.
- Cycle-1's acceptance test set is exactly the falsifiability statements of the scenarios linked to those gaps.
- Cycle-2 follows with `goes-to: cycle-2` gaps after cycle-1 lands.

---

## 14. Re-audit cadence

Re-audit when **any** of:
- A new sync source is added (e.g., a new `sync-*.js`).
- A new outbound write tool is added.
- A new threat actor tier comes into scope.
- Cycle-1 or cycle-2 lands and meaningfully changes the defenses (so the public doc reflects current truth).
- **Annual baseline** if no other trigger fires.

---

## 15. Time budget

- **Target:** 1 working day.
- **Ceiling:** 2 working days.
- **Per-surface timebox:** ~30 minutes during writing pass.
- **Overrun policy:** material that doesn't fit becomes `future` findings, not blockers.

---

# Arc-Assistant v2 Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure arc-assistant from a Claude Code-specific 80-file system to a model-agnostic 28-file architecture portable across 6 AI coding tools.

**Architecture:** Replace `core/` + `user-data/` with a single `templates/` directory that mirrors the v2 workspace layout. All CLI scripts rewritten to scaffold from `templates/`, with no Handlebars dependency. Protocols rewritten in model-neutral language with integration-aware fallbacks. A `migrate-v2` command handles one-time conversion of existing v1 workspaces.

**Tech Stack:** Node.js (ESM), Commander.js (CLI). No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-26-v2-simplification-design.md`

---

## File Map

### New files to create

```
templates/
  AGENTS.md                     <- static instruction file (~70 lines)
  startup.md                    <- session startup sequence
  capture-rules.md              <- 7-bucket capture routing + inline privacy
  arc.config.json               <- default config with platform field
  .gitignore                    <- workspace gitignore
  profile.md                    <- empty with section headers
  tasks.md                      <- empty with category headers
  knowledge.md                  <- empty with domain headers
  decisions.md                  <- empty with append marker
  journal.md                    <- empty with append marker
  self-improvement.md           <- empty with section headers
  inbox.md                      <- empty with append marker
  state/
    sessions.md                 <- empty table header
    dream-state.md              <- baseline state
  protocols/
    INDEX.md                    <- protocol list with triggers
    morning-briefing.md
    weekly-review.md
    email-triage.md
    meeting-prep.md
    subscription-audit.md
    receipt-tracking.md
    todo-extraction.md
    monthly-financial.md
    dream.md
    system-maintenance.md
    quarterly-self-assessment.md
    multi-session-coordination.md

scripts/
  lib/
    find-config.js              <- shared config-finder utility
    platforms.js                <- platform pointer map + integration defaults
  migrate-v2.js                <- v1 -> v2 migration

tests/
  init.test.js
  migrate-v2.test.js
  validate.test.js
  configure.test.js
```

### Files to modify

```
package.json                   <- remove handlebars, update files, bump version
bin/arc.js                     <- add migrate-v2 command, update description
scripts/cli/init.js                <- rewrite for v2 scaffold
scripts/configure.js           <- rewrite for platform switching + integrations
scripts/update.js              <- rewrite for system-file allowlist
scripts/rollback.js            <- rewrite for pre-v2 full-restore
scripts/validate.js            <- rewrite for v2 file checks
scripts/cli/reset.js               <- rewrite for v2 user files
scripts/export.js              <- rewrite for v2 file list
scripts/check-update.js        <- update state dir path
scripts/migrate/apply.js             <- keep as-is (future migrations)
```

### Files to delete

```
user-data/                     <- entire directory (replaced by templates/)
core/                          <- entire directory (protocols move to templates/protocols/)
scripts/generate-claude-md.js  <- no more template generation
```

---

## Task 1: Shared utilities + test infrastructure

**Files:**
- Create: `scripts/lib/find-config.js`
- Create: `scripts/lib/platforms.js`
- Create: `tests/helpers.js`

- [ ] **Step 1: Create `scripts/lib/` directory**

Run: `mkdir -p scripts/lib`

- [ ] **Step 2: Write `scripts/lib/find-config.js`**

```js
// scripts/lib/find-config.js
import { existsSync } from 'fs';
import { join, resolve } from 'path';

export function findConfig(startDir) {
  let dir = resolve(startDir || '.');
  while (dir !== '/') {
    const candidate = join(dir, 'arc.config.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return null;
}

export function findWorkspace(startDir) {
  const configPath = findConfig(startDir);
  if (!configPath) return null;
  return join(configPath, '..');
}
```

- [ ] **Step 3: Write `scripts/lib/platforms.js`**

```js
// scripts/lib/platforms.js

export const PLATFORMS = {
  'claude-code': {
    pointerFile: 'CLAUDE.md',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\n',
    nativeIntegrations: {
      email: 'gmail (native via mcp__claude_ai_Gmail__)',
      calendar: 'google-calendar (native via mcp__claude_ai_Google_Calendar__)',
      storage: 'google-drive (native via mcp__claude_ai_Google_Drive__)',
    },
  },
  'cursor': {
    pointerFile: '.cursorrules',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\n',
    nativeIntegrations: {},
  },
  'gemini-cli': {
    pointerFile: 'GEMINI.md',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\n',
    nativeIntegrations: {},
  },
  'codex': {
    pointerFile: null,
    pointerContent: null,
    nativeIntegrations: {},
  },
  'windsurf': {
    pointerFile: '.windsurfrules',
    pointerContent: 'Read and follow AGENTS.md for all instructions.\n',
    nativeIntegrations: {},
  },
  'antigravity': {
    pointerFile: null,
    pointerContent: null,
    nativeIntegrations: {},
  },
};

export const ALL_INTEGRATIONS = [
  'email', 'calendar', 'storage', 'weather', 'maps', 'health', 'finance', 'browser'
];

export const SYSTEM_FILES = ['startup.md', 'capture-rules.md'];

export const USER_DATA_FILES = [
  'profile.md', 'tasks.md', 'knowledge.md', 'decisions.md',
  'journal.md', 'self-improvement.md', 'inbox.md',
];

export function generateIntegrationsMd(platform, enabledIntegrations) {
  const platformConfig = PLATFORMS[platform];
  const lines = ['# Integrations', '', `Platform: ${platform}`, '', '## Available'];

  for (const key of enabledIntegrations) {
    const native = platformConfig.nativeIntegrations[key];
    if (native) {
      lines.push(`- ${key}: ${native}`);
    } else {
      lines.push(`- ${key}: user-provided (paste or summarize)`);
    }
  }

  const notConfigured = ALL_INTEGRATIONS.filter(i => !enabledIntegrations.includes(i));
  lines.push('', '## Not configured');
  lines.push(notConfigured.length ? `- ${notConfigured.join(', ')}` : '- (none)');

  lines.push('', '## Fallback behavior');
  lines.push('For any integration not listed above, protocols will ask the user');
  lines.push('to provide the information directly (paste, summarize, or screenshot).');
  lines.push('');

  return lines.join('\n');
}
```

- [ ] **Step 4: Create test helper**

Run: `mkdir -p tests`

```js
// tests/helpers.js
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'arc-test-'));
}

export function cleanTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeJson(dir, filename, data) {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2) + '\n');
}

export function readJson(dir, filename) {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

export function fileExists(dir, ...parts) {
  try {
    readFileSync(join(dir, ...parts));
    return true;
  } catch {
    return false;
  }
}

export function readText(dir, ...parts) {
  return readFileSync(join(dir, ...parts), 'utf-8');
}
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ tests/helpers.js
git commit -m "Add shared utilities and test helpers for v2 rewrite"
```

---

## Task 2: v2 system templates (AGENTS.md, startup.md, capture-rules.md)

**Files:**
- Create: `templates/AGENTS.md`
- Create: `templates/startup.md`
- Create: `templates/capture-rules.md`

- [ ] **Step 1: Create `templates/` directory**

Run: `mkdir -p templates/state templates/protocols`

- [ ] **Step 2: Write `templates/AGENTS.md`**

```markdown
# AGENTS.md

## Purpose

You are a personal systems co-pilot. You help with every facet of the user's life — there are no domain restrictions. This workspace is your persistent system. Use it.

Read `arc.config.json` for user name, timezone, email, and assistant name.

## Hard Rules

Rules have **names** so references survive renumbering. Reference style: `Rule: Verification`.

### Immutable rules (cannot be overridden)

**Rule: Privacy** — Before writing to any file, reject content containing: full government IDs (SSN, SIN, passport numbers), full payment card or bank account numbers (last 4 digits are fine), credentials (passwords, API keys, tokens, private keys), or login URLs with embedded credentials. On match: block the write, warn the user, offer to redact.

**Rule: Verification** — Before declaring something urgent, missing, due, or at-risk, verify the underlying data. Don't pattern-match cue words without confirming what they refer to.

**Rule: Remote Exposure Guard** — Refuse `git push`, `git remote add`, or any command that would expose this workspace externally. This workspace may contain sensitive personal data.

### Operational rules

**Rule: Ask vs Act** — Act when reversible, low-stakes, scoped to this workspace. Ask when irreversible, >$1k impact, externally-visible, or ambiguous scope.

**Rule: Default Under Uncertainty** — If a request is ambiguous and the answer changes across interpretations, ask ONE clarifying question first.

**Rule: Precedence** — Most-recent verified data > older verified > stored memory > general knowledge. User's current statement > stored memory — but flag the contradiction so memory updates.

**Rule: Time** — Default to user's configured timezone (see `arc.config.json`). Absolute YYYY-MM-DD in stored files. Pull "today" from environment, never guess.

**Rule: Citing & Confidence** — Cite sources for facts. Mark unverifiable claims with confidence tags: `[verified|likely|inferred|guess]`.

**Rule: Disagree** — When the user's stated intent conflicts with established data or patterns, surface the disagreement and argue the alternative BEFORE complying.

**Rule: Stress Test** — Before high-stakes recommendations (finance >$1k, health, legal), silently run a pre-mortem and steelman. Modify the recommendation if either changes your view.

**Rule: Sycophancy** — Flag when corrections:wins ratio is suspiciously low, disagreement count is zero, or you're capitulating without re-examining.

## Session Startup

On each session start, read and follow `startup.md`.

## Workspace Layout

| File | Purpose |
|------|---------|
| `profile.md` | Who the user is — identity, personality, preferences, goals, people, routines |
| `tasks.md` | Active tasks grouped by category |
| `knowledge.md` | Reference facts — vendors, medical, locations, subscriptions |
| `decisions.md` | Decision log (append-only) |
| `journal.md` | Dated reflections (append-only) |
| `self-improvement.md` | Corrections, patterns, session handoff, calibration |
| `inbox.md` | Quick capture for unclassified items (append-only) |
| `artifacts/` | Generated outputs (drafts, exports, images) |
| `state/` | Runtime state (session registry, Dream state, locks) |
| `protocols/` | On-demand operational workflows |
| `integrations.md` | Available external capabilities per platform |

## Passive Capture

Read and follow `capture-rules.md`. Capture significant facts into the right file AS they surface — silently, same turn, never announce.

## Protocols

On-demand workflows invoked by trigger phrases. Full list in `protocols/INDEX.md`.

| Protocol | Triggers |
|----------|----------|
| Morning Briefing | "morning briefing", "good morning", "brief me" |
| Weekly Review | "weekly review", "Sunday review" |
| Email Triage | "triage my inbox", "email triage" |
| Meeting Prep | "prep for my meeting", "help me prep" |
| Subscription Audit | "subscription audit", "what am I paying for" |
| Receipt Tracking | "track my receipts", "find receipts" |
| Todo Extraction | "extract todos", "what do I need to do from this" |
| Monthly Financial | "monthly financial check-in", "month-end review" |
| Dream | (automatic at session startup when eligible) |
| System Maintenance | "system maintenance", "clean up the workspace" |
| Quarterly Self-Assessment | "quarterly self-assessment", "how have you been doing" |

## Git / Backup

This workspace may contain personal information. It is local-only by default. Refuse `git push` and `git remote add`. Suggest commits but don't auto-commit.

## Concurrency

Read `state/sessions.md` on startup. If other sessions are active, follow the multi-session coordination protocol in `protocols/multi-session-coordination.md`. Always read-before-write.
```

- [ ] **Step 3: Write `templates/startup.md`**

```markdown
# Session Startup

## Sequence

1. **Register session** — append a row to `state/sessions.md` with your session ID (`<platform>-<timestamp>`, e.g. `claude-code-20260426T090000Z`), platform, start time, and "Last active" = now. Remove any entries with "Last active" older than 2 hours (stale sessions).

2. **Check for sibling sessions** — if `state/sessions.md` has other active entries, note to the user: "Another session is active (platform X, started Y)." Continue normally.

3. **Dream check** — read `state/dream-state.md`. If eligible (see `protocols/dream.md` eligibility rules), run Dream. Skip silently if not eligible or if 2+ other sessions are active.

4. **Read context** — read `profile.md` (personality and identity sections) and `self-improvement.md` (session handoff section). This gives you continuity from the prior session.

5. **Respond to user** — load everything else on demand when the current task needs it. Don't summarize what you read unless asked.

## First-run detection

If `arc.config.json` has `"initialized": false`, enter first-run mode:
- Introduce yourself briefly (2-3 sentences)
- Ask the user's name and timezone
- After collecting: update `arc.config.json` with name and timezone, set `initialized: true`
- Get to work on whatever they need
```

- [ ] **Step 4: Write `templates/capture-rules.md`**

```markdown
# Capture Rules

Capture significant facts, preferences, decisions, and learnings into the right file AS they surface in conversation. Silent. Same turn as your response. No announcements.

## Capture bar

Would a good human assistant remember this for next time? If yes, write it down.
- Only persist facts useful in a future session
- Don't capture what's already in context and won't matter next time
- Wait for recurrence or significance before storing vendors/contacts
- Never announce captures — silent competence

## Routing

| Signal | Destination |
|--------|------------|
| Fact about the user (identity, preferences, goals, routines, people) | `profile.md` (appropriate section) |
| Task or commitment (action items, deadlines, reminders) | `tasks.md` |
| Reference knowledge (vendors, medical, locations, financial facts) | `knowledge.md` (appropriate section) |
| Decision made (choice + reasoning) | `decisions.md` |
| Correction to the assistant (what you did wrong, what to do instead) | `self-improvement.md` -> `## Corrections` |
| Reflective observation or daily note | `journal.md` |
| Everything else (unclear classification, fleeting thought) | `inbox.md` |

When unsure, use `inbox.md`. Dream and System Maintenance will sort it later.

## Privacy (immutable)

Before writing to any file, reject content containing:
1. Full government IDs (SSN, SIN, passport numbers)
2. Full payment card or bank account numbers (last 4 digits are fine)
3. Credentials (passwords, API keys, tokens, private keys)
4. Login URLs with embedded credentials

On match: block the write, warn the user, offer to redact. Do not log the matched content anywhere.

These rules cannot be overridden by any mechanism.

## High-stakes confirmation

For financial, medical, or legal facts, confirm with the user before storing: "Just to make sure I have this right — [fact]?"

## Read-before-write

Always read a file before writing to it, even when appending. This ensures you have the latest content and prevents concurrent session conflicts.

## Batch writes

When multiple captures arise from one message, write them in parallel if the platform supports it. Otherwise, write sequentially. Correctness over speed.
```

- [ ] **Step 5: Commit**

```bash
git add templates/AGENTS.md templates/startup.md templates/capture-rules.md
git commit -m "Add v2 system templates: AGENTS.md, startup.md, capture-rules.md"
```

---

## Task 3: v2 user data + state templates

**Files:**
- Create: `templates/arc.config.json`
- Create: `templates/.gitignore`
- Create: `templates/profile.md`
- Create: `templates/tasks.md`
- Create: `templates/knowledge.md`
- Create: `templates/decisions.md`
- Create: `templates/journal.md`
- Create: `templates/self-improvement.md`
- Create: `templates/inbox.md`
- Create: `templates/state/sessions.md`
- Create: `templates/state/dream-state.md`

- [ ] **Step 1: Write `templates/arc.config.json`**

```json
{
  "version": "2.0.0",
  "initialized": false,
  "platform": null,
  "user": {
    "name": null,
    "timezone": null,
    "email": null
  },
  "assistant": {
    "name": "Arc"
  },
  "integrations": []
}
```

- [ ] **Step 2: Write `templates/.gitignore`**

```
# Runtime state
state/locks/

# OS noise
.DS_Store
Thumbs.db

# Editor temp files
*.swp
*.swo
*~
.idea/
.vscode/

# Tool scratch
*.tmp
*.bak

# Node
node_modules/

# Superpowers brainstorm sessions
.superpowers/
```

- [ ] **Step 3: Write the 7 user data templates**

`templates/profile.md`:
```markdown
# Profile

## Identity

<!-- Name, age, location, other basics — filled in over time -->

## Personality

<!-- Assistant's voice and style — how to communicate with this user -->
- **Tone:** Direct, practical, low-fluff. Match the user's energy.
- **Style:** Action-oriented. Execute first, explain only if asked.
- **Brevity:** High. Bullet structure over prose.
- **Proactivity:** High — anticipate, surface relevant info without being asked.

## Preferences

<!-- Opinions, likes, dislikes — captured passively from conversation -->

## Goals

<!-- Active goals with check-in dates -->

## People

<!-- Named people with context (relationship, role, relevance) -->

## Routines

<!-- Daily/weekly habits and patterns -->

## Work

<!-- Professional context — role, company, projects, interests -->

## Interests

<!-- Hobbies, passions, topics of curiosity -->
```

`templates/tasks.md`:
```markdown
# Tasks

## Work

<!-- APPEND-ONLY below — add new tasks at the end of each section -->

## Personal

## Finance

## Health

## Learning

## Home

## Shopping
```

`templates/knowledge.md`:
```markdown
# Knowledge

## Vendors

<!-- Service providers, contacts, account details (last 4 only) -->

## Medical

<!-- Doctors, medications, conditions, appointments -->

## Locations

<!-- Places, addresses, travel notes -->

## Subscriptions

<!-- Recurring services and charges -->

## References

<!-- Miscellaneous reference information -->
```

`templates/decisions.md`:
```markdown
# Decisions

Append-only log. Newest entries at the bottom.

<!-- APPEND-ONLY below this line -->
```

`templates/journal.md`:
```markdown
# Journal

Append-only dated entries. Newest at the bottom.

<!-- APPEND-ONLY below this line -->
```

`templates/self-improvement.md`:
```markdown
# Self-Improvement

## Corrections

<!-- What the assistant got wrong and what to do instead -->
<!-- APPEND-ONLY below -->

## Patterns

<!-- Recurring tendencies — recognition signals and counter-actions -->

## Session Handoff

Rolling notes for the next session. Newest entry at the top.

<!-- APPEND-ONLY below -->

## Calibration

<!-- Prediction accuracy, confidence tracking, sycophancy checks -->
```

`templates/inbox.md`:
```markdown
# Inbox

Quick capture for items that need classification. Dream and System Maintenance process this periodically.

<!-- APPEND-ONLY below this line -->
```

- [ ] **Step 4: Write state templates**

`templates/state/sessions.md`:
```markdown
# Active Sessions

| Session | Platform | Started | Last active | Topic |
|---------|----------|---------|-------------|-------|
```

`templates/state/dream-state.md`:
```markdown
# Dream State

last_dream_at: null
sessions_since: 0
status: fresh-install
last_run_session: null

## Last summary

No Dream runs yet.

## Deferred items

(none)
```

- [ ] **Step 5: Create empty directories**

Run: `mkdir -p templates/state/locks templates/artifacts`

Create `templates/artifacts/.gitkeep` and `templates/state/locks/.gitkeep` (empty files).

- [ ] **Step 6: Commit**

```bash
git add templates/
git commit -m "Add v2 user data and state templates"
```

---

## Task 4: Rewrite protocols — integration-dependent (6 protocols)

**Files:**
- Create: `templates/protocols/morning-briefing.md`
- Create: `templates/protocols/email-triage.md`
- Create: `templates/protocols/meeting-prep.md`
- Create: `templates/protocols/subscription-audit.md`
- Create: `templates/protocols/receipt-tracking.md`
- Create: `templates/protocols/todo-extraction.md`

These 6 protocols depend on external integrations and need the integration-aware fallback pattern.

- [ ] **Step 1: Write `templates/protocols/morning-briefing.md`**

```markdown
# Protocol: Morning Briefing

## Triggers

"morning briefing", "good morning", "brief me", "what's today", "what do I have today"

## Steps

### 1. Calendar

Read `integrations.md` for calendar status.
- If available: get today's events from the user's primary calendar.
- If not available: ask "What's on your calendar today? Paste or summarize."

### 2. Email

Read `integrations.md` for email status.
- If available: search inbox for unread/important threads since yesterday morning.
- If not available: ask "Any important emails I should know about?"

### 3. Tasks

Read `tasks.md`. Collect:
- Items due today
- Overdue items
- Top high-priority pending items

### 4. Context

Read `self-improvement.md` (session handoff section) for active context from prior sessions.

### 5. Compose briefing

Present in this order:
- **Calendar today** — events with times, chronological
- **Inbox highlights** — count + 2-3 items needing attention (if email available)
- **Due today** — tasks with today's due date
- **Watch-list** — overdue or top high-priority items
- **Suggested focus** — 1-2 priorities for the day

## Format

Bullet-style, scannable. Under 200 words unless the day is unusually packed.

## After briefing

Ask: "Anything to add to the day or capture before you start?"
```

- [ ] **Step 2: Write `templates/protocols/email-triage.md`**

```markdown
# Protocol: Email Triage

## Triggers

"triage my inbox", "email triage", "go through my email", "what's in my inbox"

## Prerequisites

Read `integrations.md` for email status.
- If email is not available: ask the user to paste or forward email content, then proceed with classification below.

## Steps

1. Get inbox threads (unread or all, based on user preference).
2. For each thread, classify:
   - **Action required** — needs response or task. Suggest a todo + draft response if quick.
   - **FYI / read later** — informational. Note key point.
   - **Receipt / billing** — extract amount, vendor, date. Log to `knowledge.md` -> `## Subscriptions` if recurring.
   - **Newsletter / promo** — note if anything actionable, suggest unsubscribe if low value.
   - **Spam / junk** — flag for cleanup.
3. Group output by category. Within "Action required," sort by urgency.

## Output format

```
## Action Required (N)
- [Subject] — From: X — Why: short reason -> suggested action

## FYI (N)
- [Subject] — One-line summary

## Receipts/Billing (N)
- [Vendor] — $X — date

## Promos/Newsletters (N)
- [List]
```

## After triage

Ask: "Want me to draft replies, add todos for any of these, or unsubscribe from anything?"
```

- [ ] **Step 3: Write `templates/protocols/meeting-prep.md`**

```markdown
# Protocol: Meeting Prep

## Triggers

"prep for my meeting", "prep for my event", "what's on my calendar at [time]", "help me prep for [event]"

## Steps

### 1. Get the event

Read `integrations.md` for calendar status.
- If available: get the calendar event (subject, time, attendees, location, description).
- If not available: ask "What's the meeting? Give me the subject, time, attendees, and any context."

### 2. Search for related context

Read `integrations.md` for email status.
- If email available: search for threads by subject keywords and attendee names (past 30 days).
- If not available: ask "Any recent email threads related to this meeting?"

Read `integrations.md` for storage status.
- If storage available: search for documents by subject keywords and attendee names.
- If not available: skip this section.

### 3. Check workspace

Read `knowledge.md` for any vendor/contact/topic matching the meeting subject.
Read `journal.md` and `profile.md` for prior context.

## Output

- **Meeting:** subject, time, attendees, location
- **Context:** what this is about (1-2 sentences)
- **Recent threads:** key points from related email (if available)
- **Relevant docs:** document summaries (if available)
- **Prep questions:** what to think about beforehand
- **Suggested talking points:** if applicable

## After prep

Ask: "Anything specific you want to dig into before the meeting?"
```

- [ ] **Step 4: Write `templates/protocols/subscription-audit.md`**

```markdown
# Protocol: Subscription Audit

## Triggers

"subscription audit", "find my subscriptions", "what am I paying for", "audit recurring charges"

## Steps

### 1. Gather charges

Read `integrations.md` for email status.
- If email available: search for recurring-charge signals — "subscription", "renewal", "auto-renew", "monthly payment", "annual subscription", "your receipt", "invoice", "billing". Search common providers: streaming, music, cloud storage, SaaS, gym, insurance.
- If not available: ask "Can you paste a recent bank statement or list your known recurring charges?"

### 2. Extract per charge

- Vendor name
- Amount
- Frequency (monthly/annual)
- Last charge date

### 3. Cross-reference

Read `knowledge.md` -> `## Subscriptions` for previously tracked charges.

### 4. Flag

- Charges not in `knowledge.md`
- Mystery charges (unknown or unexpected)
- Duplicates
- Forgotten subscriptions (not used recently)

## Output

| Vendor | Amount | Freq | Last charge | Notes |

## After audit

Suggest cancellations. Update `knowledge.md` -> `## Subscriptions` with confirmed recurring charges.
```

- [ ] **Step 5: Write `templates/protocols/receipt-tracking.md`**

```markdown
# Protocol: Receipt Tracking

## Triggers

"track my receipts", "what did I spend on", "find receipts for", "what did I buy from [vendor]"

## Steps

### 1. Gather receipts

Read `integrations.md` for email status.
- If email available: search for receipt/order keywords + optional vendor/date filter — "receipt", "order confirmation", "your order", "shipped".
- If not available: ask "Can you paste or forward the receipts you want tracked?"

### 2. Extract per receipt

Vendor, amount, items, date, order ID.

### 3. Aggregate if needed

If the user is tracking spending in a category (e.g., monthly cap), sum across the period.

## Use cases

- Tax receipts (HSA-eligible medical, charitable, business)
- Returns/warranties (find original purchase)
- Spending audits (category caps, dining out, gear)
- Big-ticket records

## Output

Per-receipt or aggregated summary depending on the question.

## After

If a recurring category audit, log results to `knowledge.md`. If a one-time lookup, no need to persist.
```

- [ ] **Step 6: Write `templates/protocols/todo-extraction.md`**

```markdown
# Protocol: Todo Extraction

## Triggers

- User forwards or pastes an email/message and says "extract todos", "what do I need to do from this", "add this to my todos"
- User shares a long thread and asks for action items

## Steps

1. Read the email/thread/document carefully.
2. Identify explicit asks ("can you", "please", "we need", "by [date]").
3. Identify implicit obligations (commitments user made, follow-ups owed).
4. For each, classify:
   - **Action item** -> add to appropriate section in `tasks.md`
   - **FYI / context** -> note in `journal.md` if useful for future sessions
   - **Decision needed** -> create entry in `decisions.md`
5. Extract: task description, due date if mentioned, priority based on tone/sender.

## Output

List of extracted items with:
- What section of `tasks.md` it goes into
- Proposed task wording
- Due date if any
- Priority

Confirm with user before adding, unless they said "just add them."

## After

Add confirmed items to the relevant files.
```

- [ ] **Step 7: Commit**

```bash
git add templates/protocols/morning-briefing.md templates/protocols/email-triage.md \
  templates/protocols/meeting-prep.md templates/protocols/subscription-audit.md \
  templates/protocols/receipt-tracking.md templates/protocols/todo-extraction.md
git commit -m "Add v2 integration-dependent protocols (6 of 12)"
```

---

## Task 5: Rewrite protocols — workspace-only (6 protocols + INDEX)

**Files:**
- Create: `templates/protocols/weekly-review.md`
- Create: `templates/protocols/monthly-financial.md`
- Create: `templates/protocols/dream.md`
- Create: `templates/protocols/system-maintenance.md`
- Create: `templates/protocols/quarterly-self-assessment.md`
- Create: `templates/protocols/multi-session-coordination.md`
- Create: `templates/protocols/INDEX.md`

- [ ] **Step 1: Write `templates/protocols/weekly-review.md`**

```markdown
# Protocol: Weekly Review

## Triggers

"weekly review", "let's review the week", "Sunday review"

## Steps

### 1. Last week recap

- Read `tasks.md` for completed items in the past 7 days.
- Read `integrations.md` for calendar status.
  - If available: list events that happened this week.
  - If not available: ask "What were the key events this week?"

### 2. Backlog health

- Todos in `tasks.md` older than 14 days untouched -> flag as stale, ask to keep/drop/defer.
- Overdue items -> re-prioritize.

### 3. Financial check (mini)

- Read `integrations.md` for email status.
  - If available: pull recent receipts/orders.
  - If not available: skip or ask "Any notable spending this week?"
- Check `knowledge.md` -> `## Subscriptions` for anything anomalous.

### 4. Goal check-ins

Read `profile.md` -> `## Goals`. Prompt the user for progress on active goals.

### 5. Look ahead

- Read `integrations.md` for calendar status.
  - If available: next 7 days of calendar.
  - If not available: ask "What's coming up next week?"
- Prep needed for any meetings/events?

### 6. Decisions waiting

Read `decisions.md` for entries marked pending input.

### 7. Inbox sweep

Read `inbox.md`. For each entry, classify per `capture-rules.md` routing and move to the right file.

## Output

Section-by-section summary. End with: "Anything to capture or commit to before next week?"
```

- [ ] **Step 2: Write `templates/protocols/monthly-financial.md`**

```markdown
# Protocol: Monthly Financial Check-In

## Triggers

"monthly financial check-in", "month-end review", "let's check my finances"

## Steps

1. **Income reconciliation** — paychecks landed as expected? Any vesting events this month?
2. **Recurring outflows** — verify against `knowledge.md` -> `## Subscriptions`.
3. **Variable spending** — use receipt-tracking and subscription-audit protocols if email is available. Otherwise ask the user for a spending summary.
4. **Account balances** — ask the user for current balances across accounts (checking, savings, investment, retirement, HSA).
5. **Debt progress** — review any outstanding balances tracked in `knowledge.md`.
6. **Tax check** — any estimated tax due this quarter? Withholding on track?
7. **Net worth delta** — month-over-month change.

## Output

- Cashflow (in vs out)
- Net change in net worth
- Anomalies / things needing attention
- Next month's priorities

## After

Update `knowledge.md` with any new financial facts. Log the review in `journal.md`.
```

- [ ] **Step 3: Write `templates/protocols/dream.md`**

```markdown
# Protocol: Dream

Lightweight automatic memory consolidation. Runs at session startup when conditions are met.

## Triggers

Automatic only — invoked from `startup.md`. Never invoked manually.

## Eligibility check

Run after session registration, before reading `profile.md`.

1. Read `state/dream-state.md`.
   - File missing or `status: fresh-install` -> create baseline (status: baseline-only, last_dream_at=now, sessions_since=0), write file, SKIP.
2. Increment `sessions_since` by 1, write back to `state/dream-state.md`.
3. Skip checks (any -> SKIP, do not reset counter):
   - 2+ other sessions listed as active in `state/sessions.md`
4. Eligibility:
   - elapsed = now - last_dream_at
   - eligible = (elapsed >= 24h AND sessions_since >= 5) OR (elapsed >= 72h)
   - Not eligible -> SKIP
5. Eligible -> acquire `state/locks/dream.lock` (follow lock protocol in `protocols/multi-session-coordination.md`).
   - Lock held -> SKIP (do not reset counter)
   - Lock acquired -> proceed to phases

After running (whether complete or partial), always:
- Delete `state/locks/dream.lock`
- Update `state/dream-state.md`: last_dream_at=now, sessions_since=0
- Print one-line summary OR escalation report

## Phase 1: Scan

Read these files:
- `state/dream-state.md` (for `last_dream_at` timestamp)
- `journal.md` — identify entries dated after `last_dream_at`
- `inbox.md` — identify all unprocessed entries
- `tasks.md` — scan for completed or stale items
- `self-improvement.md` — read session handoff section

## Phase 2: Consolidate

For each item identified in the scan:

1. **Inbox routing** — for each entry in `inbox.md`:
   - Classify per `capture-rules.md` routing table
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE

2. **Fact promotion** — durable facts in `journal.md` entries (e.g., "got a new doctor: Dr. Smith") -> promote to `profile.md` or `knowledge.md`.

3. **Task pruning** — completed tasks older than 60 days -> remove. Stale tasks (no activity >30 days) -> flag for user review at next interaction.

4. **Session handoff cleanup** — entries in `self-improvement.md` -> `## Session Handoff` older than 14 days -> archive to `journal.md` or delete if resolved.

5. **Correction promotion** — if a mistake type appears 2+ times in `## Corrections`, add to `## Patterns` with recognition signals and counter-action.

## Boundary rule

Dream can read and write any of the 8 core data files (profile.md, tasks.md, knowledge.md, decisions.md, journal.md, self-improvement.md, inbox.md).

Dream manages its own `state/locks/dream.lock` (create/delete) but NEVER edits other lock files.

Dream NEVER edits: `AGENTS.md`, `protocols/`, `integrations.md`, `startup.md`, `capture-rules.md`, `arc.config.json`.

Dream NEVER runs external commands or makes network requests.

## Output

### Default (silent)

One-line summary: "Dreamt: pruned N items, routed M from inbox, promoted K facts."

### Escalation report

Triggered by: unresolvable contradictions, ambiguous inbox items, time-sensitive routed items, or errors. Present under a `## Needs your input` heading. Neutral, factual tone.

## Failure modes

- Lock held -> skip cleanly, do not reset counter
- Error mid-phase -> mark status: partial, release lock, escalate
- If `state/dream-state.md` is corrupted -> recreate baseline, skip this run
```

- [ ] **Step 4: Write `templates/protocols/system-maintenance.md`**

```markdown
# Protocol: System Maintenance

Run monthly (first session of the month) or when triggered.

## Triggers

"system maintenance", "maintenance pass", "audit the system", "clean up the workspace"

Proactive: first session of a new month — offer it.

## Steps

### 1. Task health

- Read `tasks.md`. Find items with no activity for >30 days. Ask user: keep / drop / defer.
- Find completed tasks older than 60 days. Remove or archive to `journal.md`.

### 2. Inbox processing

- Read `inbox.md`. For each entry, classify per `capture-rules.md` routing. Move to destination. Goal: empty inbox.

### 3. Correction -> Pattern promotion

- Read `self-improvement.md` -> `## Corrections`. For mistake types appearing 2+ times, add to `## Patterns` with recognition signals and counter-actions.

### 4. Session handoff cleanup

- Read `self-improvement.md` -> `## Session Handoff`. Entries >14 days old -> resolved or archived to `journal.md`.

### 5. Decisions follow-up

- Read `decisions.md`. For decisions >30 days old with no recorded outcome, ask user for the outcome. Update the entry.

### 6. Goals check-in

- Read `profile.md` -> `## Goals`. Prompt user for progress on active goals.

### 7. Profile freshness

- Skim `profile.md` and `knowledge.md`. Flag any information that seems outdated based on recent conversation context.

### 8. Calibration check

- Read `self-improvement.md` -> `## Calibration`. Update prediction accuracy if any verifiable predictions have matured.

### 9. Disagreement budget

- In past month, how often did the assistant push back on the user's stated intent? If zero, scan for moments it should have.

### 10. Coordination cleanup

- Read `state/sessions.md`. Remove stale entries (>2 hours old).
- Check `state/locks/` for any lock files older than 24 hours. Delete them (stale from crashed sessions).

## Output

Summary report with sections: Tasks, Inbox, Patterns, Decisions, Profile, Open Questions.

## After

Log completion date in `journal.md` so next maintenance knows the baseline.
```

- [ ] **Step 5: Write `templates/protocols/quarterly-self-assessment.md`**

```markdown
# Protocol: Quarterly Self-Assessment

Every 3 months, assess whether self-improvement is working — not just logging activity.

## Triggers

"quarterly self-assessment", "review your performance", "how have you been doing"

Proactive: first session of each quarter (Jan/Apr/Jul/Oct).

## Steps

### 1. Effectiveness audit

Pick 5 high-stakes responses from the past 90 days (financial advice, health recommendations, action items). For each:
- Was the recommendation correct?
- Did the user act on it?
- What was the outcome?
- Grade 1-5

Compare to prior quarter's grades.

### 2. Calibration audit

Read `self-improvement.md` -> `## Calibration`. For verified predictions: was tagged confidence calibrated to actual accuracy? Group by band (50%/70%/90%) and check.

### 3. Correction/Pattern compounding

- How many corrections in 90 days vs prior quarter?
- For each pattern in `## Patterns`: is the counter-action working?

### 4. Sycophancy check

- Read `self-improvement.md`. Are most entries positive corrections?
- Is the disagreement count zero? If so, scan for moments the assistant should have pushed back.
- High wins-to-corrections ratio + low disagreement = probably optimizing for praise.

### 5. Ask the user to grade the assistant

Direct: "Honestly, how am I doing? What's working? What's not?" Log response in `self-improvement.md` -> `## Corrections` or `## Calibration`.

### 6. Identify ONE thing to change

Pick the single highest-leverage improvement for the next quarter.

## Output

```
## Quarterly Self-Assessment — YYYY-Q#

### Effectiveness: [grades, trend]
### Calibration: [accuracy by band]
### Corrections/Patterns: [count, trend]
### Sycophancy: [concern yes/no, evidence]
### User's grade: [quote]
### One thing to change: [specific commitment]
```

## After

Log in `journal.md`. Update `self-improvement.md` -> `## Calibration`.
```

- [ ] **Step 6: Write `templates/protocols/multi-session-coordination.md`**

```markdown
# Protocol: Multi-Session Coordination

The user may run multiple AI sessions concurrently. This protocol prevents data loss and conflicts using file-based coordination.

## Triggers

- Automatic on every session start (register in `state/sessions.md`)
- Automatic before editing pillar files (acquire lock)
- "list active sessions", "who else is running", "session status"

## Session ID format

`<platform>-<timestamp>` — e.g., `claude-code-20260426T090000Z`. Read the platform from `integrations.md` or `arc.config.json`.

## Session lifecycle

### On startup

1. Read `state/sessions.md`.
2. Remove entries with "Last active" older than 2 hours (stale).
3. Append a new row: your session ID, platform, start time, last active = now.
4. If other active entries exist, tell the user.

### During session

Update your "Last active" timestamp periodically (~every 10 file operations or before editing pillar files).

### On session end

Best effort: remove your row from `state/sessions.md`.

## File categories

| Category | Files | Rule |
|----------|-------|------|
| Pillar (always lock) | `AGENTS.md`, `profile.md`, `self-improvement.md` | Acquire lock before any edit |
| Mixed-use | `tasks.md`, `knowledge.md` | Lock when modifying or removing existing content. Appending a new entry is safe without a lock. When in doubt, lock. |
| Append-only | `journal.md`, `decisions.md`, `inbox.md` | No lock needed. Read-before-write still applies. |

## Lock protocol

To edit a pillar or mixed-use file:

1. Check if `state/locks/<filename>.lock` exists.
2. If it exists, read it:
   - Timestamp < 5 minutes old -> lock is held. Tell the user: "Another session is editing <file>. Wait or work on something else?"
   - Timestamp > 5 minutes old -> stale lock. Delete the file and proceed.
3. If no lock exists, create `state/locks/<filename>.lock`:
   ```
   session: <your-session-id>
   acquired: <ISO-8601-timestamp>
   ```
4. **Confirm-after-create:** re-read the lock file immediately. If it contains a different session ID, another session won the race. Delete the lock file, wait briefly, retry from step 1.
5. Read the target file fresh (never trust cached content).
6. Make your edit.
7. Delete the lock file.

## Read-before-write (always)

Read a file immediately before writing to it. Do not rely on content read earlier in the session. Another session may have changed it.

## What this does NOT solve

- Two sessions sending the same email -> use `Rule: Ask vs Act`
- Cross-session context -> Session A's learnings aren't visible to Session B until Session B reads the workspace files
```

- [ ] **Step 7: Write `templates/protocols/INDEX.md`**

```markdown
# Protocols Index

Operational workflows that run on-demand or on cadence. When the user invokes a trigger phrase, read and follow the corresponding protocol.

| Protocol | File | Triggers |
|----------|------|----------|
| Morning Briefing | `morning-briefing.md` | "morning briefing", "good morning", "brief me", "what's today" |
| Weekly Review | `weekly-review.md` | "weekly review", "Sunday review" |
| Email Triage | `email-triage.md` | "triage my inbox", "email triage", "go through my email" |
| Meeting Prep | `meeting-prep.md` | "prep for my meeting", "help me prep for [event]" |
| Subscription Audit | `subscription-audit.md` | "subscription audit", "what am I paying for" |
| Receipt Tracking | `receipt-tracking.md` | "track my receipts", "find receipts for" |
| Todo Extraction | `todo-extraction.md` | "extract todos", "what do I need to do from this" |
| Monthly Financial | `monthly-financial.md` | "monthly financial check-in", "month-end review" |
| Dream | `dream.md` | (automatic at session startup when eligible) |
| System Maintenance | `system-maintenance.md` | "system maintenance", "clean up the workspace" |
| Quarterly Self-Assessment | `quarterly-self-assessment.md` | "quarterly self-assessment", "how have you been doing" |
| Multi-Session Coordination | `multi-session-coordination.md` | (automatic), "list active sessions" |

## Cadence

- **Per session:** Dream (automatic eligibility check)
- **Monthly:** System Maintenance (first session of month)
- **Quarterly:** Quarterly Self-Assessment (first session of quarter)
- **Triggered:** All others — invoked by user trigger phrases
```

- [ ] **Step 8: Commit**

```bash
git add templates/protocols/
git commit -m "Add v2 workspace-only protocols and INDEX (6 of 12 + INDEX)"
```

---

## Task 6: Update package.json + bin/arc.js

**Files:**
- Modify: `package.json`
- Modify: `bin/arc.js`

- [ ] **Step 1: Update `package.json`**

Remove `handlebars` from dependencies. Update `files` to include `templates/` instead of `core/` and `user-data/`. Bump version to `2.0.0`. Add `scripts/lib/` to files.

```json
{
  "name": "arc-assistant",
  "version": "2.0.0",
  "description": "A self-improving personal assistant — portable across AI coding tools",
  "type": "module",
  "bin": {
    "arc": "./bin/arc.js"
  },
  "files": [
    "bin/",
    "templates/",
    "scripts/"
  ],
  "scripts": {
    "test": "node --test tests/**/*.test.js"
  },
  "dependencies": {
    "commander": "^13.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [
    "ai",
    "assistant",
    "personal-assistant",
    "claude-code",
    "cursor",
    "gemini-cli",
    "codex",
    "windsurf"
  ],
  "license": "MIT",
  "author": "Kevin K Lee",
  "repository": {
    "type": "git",
    "url": ""
  }
}
```

- [ ] **Step 2: Rewrite `bin/arc.js`**

```js
#!/usr/bin/env node

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

program
  .name('arc')
  .description('A self-improving personal assistant — portable across AI coding tools')
  .version('2.0.0');

program
  .command('init [directory]')
  .description('Scaffold a new Arc workspace')
  .option('--force', 'Allow init in non-empty directory')
  .option('--platform <platform>', 'AI tool platform (claude-code, cursor, gemini-cli, codex, windsurf, antigravity)')
  .action(async (directory, options) => {
    const { init } = await import(join(PKG_ROOT, 'scripts', 'init.js'));
    await init(directory || '.', options, PKG_ROOT);
  });

program
  .command('configure')
  .description('Update workspace configuration')
  .option('--name <name>', 'User name')
  .option('--timezone <tz>', 'Timezone (IANA format)')
  .option('--email <email>', 'Email address')
  .option('--assistant-name <name>', 'Assistant name (default: Arc)')
  .option('--platform <platform>', 'Switch AI tool platform')
  .option('--add-integration <name>', 'Add an integration (email, calendar, storage, etc.)')
  .option('--remove-integration <name>', 'Remove an integration')
  .action(async (options) => {
    const { configure } = await import(join(PKG_ROOT, 'scripts', 'configure.js'));
    await configure(options, PKG_ROOT);
  });

program
  .command('update')
  .description('Update system files and protocols to the latest version')
  .action(async () => {
    const { update } = await import(join(PKG_ROOT, 'scripts', 'update.js'));
    await update(PKG_ROOT);
  });

program
  .command('check-update')
  .description('Check for available updates')
  .action(async () => {
    const { checkUpdate } = await import(join(PKG_ROOT, 'scripts', 'check-update.js'));
    await checkUpdate(PKG_ROOT);
  });

program
  .command('rollback')
  .description('Restore from the most recent backup')
  .action(async () => {
    const { rollback } = await import(join(PKG_ROOT, 'scripts', 'rollback.js'));
    await rollback(PKG_ROOT);
  });

program
  .command('validate')
  .description('Check workspace integrity')
  .action(async () => {
    const { validate } = await import(join(PKG_ROOT, 'scripts', 'validate.js'));
    await validate();
  });

program
  .command('export')
  .description('Export all user data as a portable archive')
  .action(async () => {
    const { exportData } = await import(join(PKG_ROOT, 'scripts', 'export.js'));
    await exportData();
  });

program
  .command('reset')
  .description('Wipe user data files back to empty templates')
  .action(async () => {
    const { reset } = await import(join(PKG_ROOT, 'scripts', 'reset.js'));
    await reset(PKG_ROOT);
  });

program
  .command('migrate-v2')
  .description('One-time migration from v1 workspace layout to v2')
  .action(async () => {
    const { migrateV2 } = await import(join(PKG_ROOT, 'scripts', 'migrate-v2.js'));
    await migrateV2(PKG_ROOT);
  });

program
  .command('version')
  .description('Show current version')
  .action(() => {
    console.log('arc-assistant v2.0.0');
  });

program.parse();
```

- [ ] **Step 3: Run `npm uninstall handlebars`**

Run: `npm uninstall handlebars`

Verify `package-lock.json` is updated and handlebars is gone.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json bin/arc.js
git commit -m "Update package.json and CLI entry point for v2"
```

---

## Task 7: Rewrite scripts/cli/init.js

**Files:**
- Modify: `scripts/cli/init.js`
- Test: `tests/init.test.js`

- [ ] **Step 1: Write test `tests/init.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, readJson, fileExists } from './helpers.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

describe('arc init', () => {
  let tmpDir;

  before(() => { tmpDir = createTempDir(); });
  after(() => { cleanTempDir(tmpDir); });

  it('scaffolds all expected files for claude-code platform', async () => {
    const { initWithOptions } = await import('../scripts/cli/init.js');
    const targetDir = join(tmpDir, 'workspace');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'claude-code',
      name: 'Test User',
      timezone: 'America/New_York',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(fileExists(targetDir, 'CLAUDE.md'), 'CLAUDE.md pointer exists');
    assert.ok(fileExists(targetDir, 'startup.md'), 'startup.md exists');
    assert.ok(fileExists(targetDir, 'capture-rules.md'), 'capture-rules.md exists');
    assert.ok(fileExists(targetDir, 'integrations.md'), 'integrations.md exists');
    assert.ok(fileExists(targetDir, 'profile.md'), 'profile.md exists');
    assert.ok(fileExists(targetDir, 'tasks.md'), 'tasks.md exists');
    assert.ok(fileExists(targetDir, 'knowledge.md'), 'knowledge.md exists');
    assert.ok(fileExists(targetDir, 'decisions.md'), 'decisions.md exists');
    assert.ok(fileExists(targetDir, 'journal.md'), 'journal.md exists');
    assert.ok(fileExists(targetDir, 'self-improvement.md'), 'self-improvement.md exists');
    assert.ok(fileExists(targetDir, 'inbox.md'), 'inbox.md exists');
    assert.ok(fileExists(targetDir, 'state', 'sessions.md'), 'state/sessions.md exists');
    assert.ok(fileExists(targetDir, 'state', 'dream-state.md'), 'state/dream-state.md exists');
    assert.ok(existsSync(join(targetDir, 'state', 'locks')), 'state/locks/ exists');
    assert.ok(existsSync(join(targetDir, 'artifacts')), 'artifacts/ exists');
    assert.ok(fileExists(targetDir, 'protocols', 'INDEX.md'), 'protocols/INDEX.md exists');
    assert.ok(fileExists(targetDir, 'protocols', 'dream.md'), 'protocols/dream.md exists');

    const config = readJson(targetDir, 'arc.config.json');
    assert.equal(config.platform, 'claude-code');
    assert.equal(config.user.name, 'Test User');
    assert.equal(config.user.timezone, 'America/New_York');
    assert.equal(config.initialized, true);

    const pointer = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8');
    assert.ok(pointer.includes('AGENTS.md'), 'CLAUDE.md points to AGENTS.md');
  });

  it('scaffolds cursor platform with .cursorrules', async () => {
    const { initWithOptions } = await import('../scripts/cli/init.js');
    const targetDir = join(tmpDir, 'cursor-ws');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'cursor',
      name: 'Test',
      timezone: 'UTC',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, '.cursorrules'), '.cursorrules exists');
    assert.ok(!fileExists(targetDir, 'CLAUDE.md'), 'no CLAUDE.md for cursor');
  });

  it('scaffolds codex platform with no pointer file', async () => {
    const { initWithOptions } = await import('../scripts/cli/init.js');
    const targetDir = join(tmpDir, 'codex-ws');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'codex',
      name: 'Test',
      timezone: 'UTC',
    }, PKG_ROOT);

    assert.ok(fileExists(targetDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(!fileExists(targetDir, 'CLAUDE.md'), 'no CLAUDE.md for codex');
    assert.ok(!fileExists(targetDir, '.cursorrules'), 'no .cursorrules for codex');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/init.test.js`
Expected: FAIL — `initWithOptions` not exported yet.

- [ ] **Step 3: Rewrite `scripts/cli/init.js`**

```js
import { existsSync, readdirSync, mkdirSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function init(directory, options, pkgRoot) {
  const platform = options.platform || await askPlatform();
  const targetDir = resolve(directory);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !options.force) {
    console.error(`Error: ${targetDir} is not empty. Use --force to override.`);
    process.exit(1);
  }

  await initWithOptions(targetDir, { ...options, platform }, pkgRoot);

  console.log(`\nDone. Open ${targetDir} in your AI coding tool — Arc will take it from here.`);
}

export async function initWithOptions(targetDir, options, pkgRoot) {
  const { platform, name, timezone, email } = options;

  mkdirSync(targetDir, { recursive: true });

  const templatesDir = join(pkgRoot, 'templates');
  cpSync(templatesDir, targetDir, { recursive: true });

  mkdirSync(join(targetDir, 'state', 'locks'), { recursive: true });
  mkdirSync(join(targetDir, 'artifacts'), { recursive: true });
  mkdirSync(join(targetDir, 'archive'), { recursive: true });

  const config = JSON.parse(readFileSync(join(targetDir, 'arc.config.json'), 'utf-8'));
  config.platform = platform;
  if (name) {
    config.user.name = name;
    config.initialized = true;
  }
  if (timezone) config.user.timezone = timezone;
  if (email) config.user.email = email;
  if (name && timezone) config.initialized = true;
  writeFileSync(join(targetDir, 'arc.config.json'), JSON.stringify(config, null, 2) + '\n');

  const integrationsMd = generateIntegrationsMd(platform, []);
  writeFileSync(join(targetDir, 'integrations.md'), integrationsMd);

  const platformConfig = PLATFORMS[platform];
  if (platformConfig && platformConfig.pointerFile) {
    writeFileSync(join(targetDir, platformConfig.pointerFile), platformConfig.pointerContent);
  }

  const isGitRepo = existsSync(join(targetDir, '.git'));
  if (!isGitRepo) {
    try {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
    } catch { /* git not available */ }
  }

  const hooksDir = join(targetDir, '.git', 'hooks');
  if (existsSync(join(targetDir, '.git'))) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-push'), PRE_PUSH_HOOK);
    chmodSync(join(hooksDir, 'pre-push'), 0o755);
  }
}

async function askPlatform() {
  const platforms = Object.keys(PLATFORMS);
  console.log('\nWhich AI tool are you using?');
  platforms.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\nSelect (1-6): ', answer => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(platforms[idx] || 'claude-code');
    });
  });
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Arc safety hook — this workspace may contain personal data.
echo "ERROR: This Arc workspace may contain personal data."
echo "Pushing to a remote repository is blocked for safety."
echo "If you really need to push, remove .git/hooks/pre-push"
exit 1
`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/init.test.js`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cli/init.js tests/init.test.js
git commit -m "Rewrite init.js for v2 scaffold with platform support"
```

---

## Task 8: Rewrite scripts/configure.js

**Files:**
- Modify: `scripts/configure.js`
- Test: `tests/configure.test.js`

- [ ] **Step 1: Write test `tests/configure.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson, readJson, fileExists, readText } from './helpers.js';

describe('arc configure', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
    writeJson(tmpDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC', email: null },
      assistant: { name: 'Arc' }, integrations: ['email'],
    });
    writeFileSync(join(tmpDir, 'CLAUDE.md'), 'Read and follow AGENTS.md for all instructions.\n');
    writeFileSync(join(tmpDir, 'integrations.md'), '# Integrations\n');
  });
  after(() => { cleanTempDir(tmpDir); });

  it('switches platform from claude-code to cursor', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { platform: 'cursor' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.platform, 'cursor');
    assert.ok(fileExists(tmpDir, '.cursorrules'), '.cursorrules created');
    assert.ok(!fileExists(tmpDir, 'CLAUDE.md'), 'CLAUDE.md removed');
  });

  it('updates user name', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { name: 'New Name' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.user.name, 'New Name');
  });

  it('adds an integration', async () => {
    const { configureInDir } = await import('../scripts/configure.js');
    await configureInDir(tmpDir, { addIntegration: 'calendar' });

    const config = readJson(tmpDir, 'arc.config.json');
    assert.ok(config.integrations.includes('calendar'));
    const intMd = readText(tmpDir, 'integrations.md');
    assert.ok(intMd.includes('calendar'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/configure.test.js`
Expected: FAIL — `configureInDir` not exported.

- [ ] **Step 3: Rewrite `scripts/configure.js`**

```js
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { findConfig } from './lib/find-config.js';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function configure(options, pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  await configureInDir(workspaceDir, options);
}

export async function configureInDir(workspaceDir, options) {
  const configPath = join(workspaceDir, 'arc.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  let changed = false;

  if (options.name) { config.user.name = options.name; changed = true; }
  if (options.timezone) { config.user.timezone = options.timezone; changed = true; }
  if (options.email) { config.user.email = options.email; changed = true; }
  if (options.assistantName) { config.assistant.name = options.assistantName; changed = true; }

  if (options.platform && options.platform !== config.platform) {
    const oldPlatform = PLATFORMS[config.platform];
    if (oldPlatform?.pointerFile) {
      const oldPath = join(workspaceDir, oldPlatform.pointerFile);
      if (existsSync(oldPath)) unlinkSync(oldPath);
    }

    const newPlatform = PLATFORMS[options.platform];
    if (newPlatform?.pointerFile) {
      writeFileSync(join(workspaceDir, newPlatform.pointerFile), newPlatform.pointerContent);
    }

    config.platform = options.platform;
    changed = true;

    const intMd = generateIntegrationsMd(config.platform, config.integrations || []);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (options.addIntegration) {
    if (!config.integrations) config.integrations = [];
    if (!config.integrations.includes(options.addIntegration)) {
      config.integrations.push(options.addIntegration);
      changed = true;
    }
    const intMd = generateIntegrationsMd(config.platform, config.integrations);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (options.removeIntegration) {
    if (config.integrations) {
      config.integrations = config.integrations.filter(i => i !== options.removeIntegration);
      changed = true;
    }
    const intMd = generateIntegrationsMd(config.platform, config.integrations || []);
    writeFileSync(join(workspaceDir, 'integrations.md'), intMd);
  }

  if (config.user.name && config.user.timezone) config.initialized = true;

  if (!changed) {
    console.log('Current configuration:');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('Configuration updated.');
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/configure.test.js`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/configure.js tests/configure.test.js
git commit -m "Rewrite configure.js for v2 platform switching and integrations"
```

---

## Task 9: Rewrite scripts/update.js + scripts/rollback.js

**Files:**
- Modify: `scripts/update.js`
- Modify: `scripts/rollback.js`

- [ ] **Step 1: Rewrite `scripts/update.js`**

```js
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { findConfig } from './lib/find-config.js';
import { SYSTEM_FILES } from './lib/platforms.js';
import { migrate } from './migrate.js';

export async function update(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const oldVersion = config.version;

  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
  const newVersion = pkgJson.version;

  if (oldVersion === newVersion) {
    console.log(`Already on version ${newVersion}.`);
    return;
  }

  console.log(`Updating ${oldVersion} -> ${newVersion}...`);

  const backupDir = join(workspaceDir, 'archive', `system-${oldVersion}-${formatDate()}`);
  mkdirSync(backupDir, { recursive: true });

  for (const file of SYSTEM_FILES) {
    const src = join(workspaceDir, file);
    if (existsSync(src)) {
      cpSync(src, join(backupDir, file));
    }
  }

  const protocolsSrc = join(workspaceDir, 'protocols');
  if (existsSync(protocolsSrc)) {
    cpSync(protocolsSrc, join(backupDir, 'protocols'), { recursive: true });
  }

  const templatesDir = join(pkgRoot, 'templates');
  for (const file of SYSTEM_FILES) {
    const src = join(templatesDir, file);
    if (existsSync(src)) {
      cpSync(src, join(workspaceDir, file));
    }
  }

  const newProtocols = join(templatesDir, 'protocols');
  if (existsSync(newProtocols)) {
    rmSync(join(workspaceDir, 'protocols'), { recursive: true, force: true });
    cpSync(newProtocols, join(workspaceDir, 'protocols'), { recursive: true });
  }

  await migrate(workspaceDir, pkgRoot, oldVersion, newVersion);

  config.version = newVersion;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Updated to ${newVersion}. Previous system files backed up to archive/.`);
}

function formatDate() {
  return new Date().toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Rewrite `scripts/rollback.js`**

```js
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { findConfig } from './lib/find-config.js';
import { SYSTEM_FILES } from './lib/platforms.js';

export async function rollback(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const archiveDir = join(workspaceDir, 'archive');

  if (!existsSync(archiveDir)) {
    console.error('No backups found in archive/.');
    process.exit(1);
  }

  const backups = readdirSync(archiveDir).sort().reverse();

  if (backups.length === 0) {
    console.error('No backups found in archive/.');
    process.exit(1);
  }

  const latestBackup = backups[0];
  const backupPath = join(archiveDir, latestBackup);

  if (latestBackup.startsWith('pre-v2-')) {
    console.log(`Rolling back to pre-v2 backup: ${latestBackup}`);
    console.log('This is a full workspace restore.');

    const entries = readdirSync(backupPath);
    for (const entry of entries) {
      const dest = join(workspaceDir, entry);
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(join(backupPath, entry), dest, { recursive: true });
    }

    console.log('Full rollback complete.');
    return;
  }

  console.log(`Rolling back to: ${latestBackup}`);

  for (const file of SYSTEM_FILES) {
    const src = join(backupPath, file);
    if (existsSync(src)) {
      cpSync(src, join(workspaceDir, file));
    }
  }

  const backupProtocols = join(backupPath, 'protocols');
  if (existsSync(backupProtocols)) {
    rmSync(join(workspaceDir, 'protocols'), { recursive: true, force: true });
    cpSync(backupProtocols, join(workspaceDir, 'protocols'), { recursive: true });
  }

  console.log('Rollback complete.');
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/update.js scripts/rollback.js
git commit -m "Rewrite update.js and rollback.js for v2 system-file allowlist"
```

---

## Task 10: Rewrite scripts/validate.js, reset.js, export.js, check-update.js

**Files:**
- Modify: `scripts/validate.js`
- Modify: `scripts/cli/reset.js`
- Modify: `scripts/export.js`
- Modify: `scripts/check-update.js`
- Test: `tests/validate.test.js`

- [ ] **Step 1: Write test `tests/validate.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson } from './helpers.js';

describe('arc validate', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();
    writeJson(tmpDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC', email: null },
      assistant: { name: 'Arc' }, integrations: [],
    });
    for (const f of ['AGENTS.md','startup.md','capture-rules.md','integrations.md',
      'profile.md','tasks.md','knowledge.md','decisions.md','journal.md',
      'self-improvement.md','inbox.md']) {
      writeFileSync(join(tmpDir, f), '# placeholder\n');
    }
    mkdirSync(join(tmpDir, 'state', 'locks'), { recursive: true });
    writeFileSync(join(tmpDir, 'state', 'sessions.md'), '# Active Sessions\n');
    writeFileSync(join(tmpDir, 'state', 'dream-state.md'), '# Dream State\n');
    mkdirSync(join(tmpDir, 'protocols'), { recursive: true });
    writeFileSync(join(tmpDir, 'protocols', 'INDEX.md'), '# Protocols\n');
  });
  after(() => { cleanTempDir(tmpDir); });

  it('passes validation on a complete workspace', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const result = await validateInDir(tmpDir);
    assert.equal(result.issues, 0);
  });

  it('detects missing files', async () => {
    const { validateInDir } = await import('../scripts/validate.js');
    const sparseDir = createTempDir();
    writeJson(sparseDir, 'arc.config.json', {
      version: '2.0.0', initialized: true, platform: 'claude-code',
      user: { name: 'Test', timezone: 'UTC' }, assistant: { name: 'Arc' }, integrations: [],
    });
    const result = await validateInDir(sparseDir);
    assert.ok(result.issues > 0, 'should find missing files');
    cleanTempDir(sparseDir);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/validate.test.js`
Expected: FAIL — `validateInDir` not exported.

- [ ] **Step 3: Rewrite `scripts/validate.js`**

```js
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function validate() {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  const result = await validateInDir(workspaceDir);
  console.log(`\n${result.issues === 0 ? 'All checks passed.' : `${result.issues} issue(s) found.`}`);
  process.exit(result.issues > 0 ? 1 : 0);
}

export async function validateInDir(workspaceDir) {
  let issues = 0;

  // 1. Check arc.config.json
  const configPath = join(workspaceDir, 'arc.config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    ok('arc.config.json is valid JSON');
    if (!config.user?.name) { warn('user.name not set'); }
    if (!config.user?.timezone) { warn('user.timezone not set'); }
    if (!config.platform) { warn('platform not set'); }
  } catch {
    fail('arc.config.json is invalid or missing'); issues++;
  }

  // 2. Check system files
  for (const file of ['AGENTS.md', 'startup.md', 'capture-rules.md', 'integrations.md']) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }

  // 3. Check user data files
  for (const file of USER_DATA_FILES) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }

  // 4. Check state directory
  for (const file of ['state/sessions.md', 'state/dream-state.md']) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }
  if (existsSync(join(workspaceDir, 'state', 'locks'))) {
    ok('state/locks/ exists');
  } else {
    fail('state/locks/ MISSING'); issues++;
  }

  // 5. Check protocols
  if (existsSync(join(workspaceDir, 'protocols', 'INDEX.md'))) {
    ok('protocols/INDEX.md exists');
  } else {
    fail('protocols/INDEX.md MISSING'); issues++;
  }

  // 6. Check for stale locks
  const locksDir = join(workspaceDir, 'state', 'locks');
  if (existsSync(locksDir)) {
    const locks = readdirSync(locksDir).filter(f => f.endsWith('.lock'));
    for (const lock of locks) {
      const content = readFileSync(join(locksDir, lock), 'utf-8');
      const match = content.match(/acquired:\s*(.+)/);
      if (match) {
        const acquired = new Date(match[1].trim());
        const age = (Date.now() - acquired.getTime()) / 1000 / 60;
        if (age > 5) {
          warn(`Stale lock: ${lock} (${Math.round(age)} minutes old)`);
        }
      }
    }
  }

  // 7. Check for git remotes
  try {
    const { execSync } = await import('child_process');
    const remotes = execSync('git remote -v', { cwd: workspaceDir, encoding: 'utf-8' }).trim();
    if (remotes) {
      fail('Git remotes found — this workspace may contain personal data!'); issues++;
    } else {
      ok('No git remotes (local-only)');
    }
  } catch {
    ok('No git repository or no remotes');
  }

  return { issues };
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
```

- [ ] **Step 4: Rewrite `scripts/cli/reset.js`**

```js
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function reset(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');

  const confirmed = await confirm(
    `This will DELETE user data (${USER_DATA_FILES.join(', ')}) and clear state/. System files, protocols, and config are preserved. Continue?`
  );
  if (!confirmed) { console.log('Cancelled.'); return; }

  const templatesDir = join(pkgRoot, 'templates');

  for (const file of USER_DATA_FILES) {
    const dest = join(workspaceDir, file);
    const src = join(templatesDir, file);
    if (existsSync(src)) {
      cpSync(src, dest);
    }
  }

  // Clear state
  const stateDir = join(workspaceDir, 'state');
  for (const file of ['sessions.md', 'dream-state.md']) {
    const src = join(templatesDir, 'state', file);
    if (existsSync(src)) {
      cpSync(src, join(stateDir, file));
    }
  }

  // Clear locks
  const locksDir = join(stateDir, 'locks');
  if (existsSync(locksDir)) {
    const { readdirSync } = await import('fs');
    for (const f of readdirSync(locksDir)) {
      if (f.endsWith('.lock')) rmSync(join(locksDir, f));
    }
  }

  console.log('Reset complete. User data wiped to fresh templates.');
}

function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}
```

- [ ] **Step 5: Rewrite `scripts/export.js`**

```js
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function exportData() {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  const timestamp = new Date().toISOString().slice(0, 10);
  const archiveName = `arc-export-${timestamp}.tar.gz`;

  const targets = [
    ...USER_DATA_FILES,
    'arc.config.json',
    'artifacts',
    'state',
  ].filter(d => existsSync(join(workspaceDir, d)));

  execSync(
    `tar -czf "${archiveName}" ${targets.join(' ')}`,
    { cwd: workspaceDir }
  );

  console.log(`Exported to: ${join(workspaceDir, archiveName)}`);
}
```

- [ ] **Step 6: Update `scripts/check-update.js`** — minor change: use `findConfig` from lib.

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findConfig } from './lib/find-config.js';

export async function checkUpdate(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) { process.exit(0); }

  const workspaceDir = join(configPath, '..');
  const stateDir = join(workspaceDir, 'state');
  mkdirSync(stateDir, { recursive: true });

  const cachePath = join(stateDir, 'last-update-check');
  if (existsSync(cachePath)) {
    const lastCheck = parseInt(readFileSync(cachePath, 'utf-8').trim(), 10);
    const hoursSince = (Date.now() - lastCheck) / (1000 * 60 * 60);
    if (hoursSince < 24) { process.exit(0); }
  }

  try {
    const result = execSync('npm view arc-assistant version', {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (result !== config.version) {
      console.log(`Update available: ${config.version} -> ${result}`);
    }
  } catch { /* offline */ }

  writeFileSync(cachePath, Date.now().toString());
}
```

- [ ] **Step 7: Run validate tests**

Run: `node --test tests/validate.test.js`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/validate.js scripts/cli/reset.js scripts/export.js scripts/check-update.js tests/validate.test.js
git commit -m "Rewrite validate, reset, export, check-update for v2"
```

---

## Task 11: Write scripts/migrate-v2.js

**Files:**
- Create: `scripts/migrate-v2.js`
- Test: `tests/migrate-v2.test.js`

- [ ] **Step 1: Write test `tests/migrate-v2.test.js`**

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempDir, cleanTempDir, writeJson, readJson, readText, fileExists } from './helpers.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..');

describe('arc migrate-v2', () => {
  let tmpDir;

  before(() => {
    tmpDir = createTempDir();

    // Simulate a v1 workspace
    writeJson(tmpDir, 'arc.config.json', {
      version: '1.0.0', initialized: true,
      user: { name: 'Kevin', timezone: 'America/New_York', email: 'k@test.com' },
      assistant: { name: 'Arc' },
      features: { dream: true, multiSession: true, autoUpdateCheck: true },
      integrations: [],
    });
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# old CLAUDE.md\n');

    // Profile files
    mkdirSync(join(tmpDir, 'profile'), { recursive: true });
    writeFileSync(join(tmpDir, 'profile', 'identity.md'), '# Identity\n\n- **Name:** Kevin\n');
    writeFileSync(join(tmpDir, 'profile', 'goals.md'), '# Goals\n\n- Learn Rust\n');

    // Todos
    mkdirSync(join(tmpDir, 'todos'), { recursive: true });
    writeFileSync(join(tmpDir, 'todos', 'work.md'), '# Work\n\n- [ ] Ship v2\n');
    writeFileSync(join(tmpDir, 'todos', 'personal.md'), '# Personal\n\n- [ ] Grocery run\n');

    // Knowledge
    mkdirSync(join(tmpDir, 'knowledge', 'vendors'), { recursive: true });
    writeFileSync(join(tmpDir, 'knowledge', 'vendors', 'README.md'), '# Vendors\n');
    mkdirSync(join(tmpDir, 'knowledge', 'medical'), { recursive: true });
    writeFileSync(join(tmpDir, 'knowledge', 'medical', 'README.md'), '# Medical\n\nDr. Smith - PCP\n');

    // Self-improvement
    mkdirSync(join(tmpDir, 'self-improvement'), { recursive: true });
    writeFileSync(join(tmpDir, 'self-improvement', 'corrections.md'), '# Corrections\n\n- Fixed date format\n');
    writeFileSync(join(tmpDir, 'self-improvement', 'session-handoff.md'), '# Session Handoff\n\nWorking on v2 migration.\n');
    writeFileSync(join(tmpDir, 'self-improvement', 'mistakes.md'), '# Mistakes\n\n- Forgot timezone\n');

    // Memory
    mkdirSync(join(tmpDir, 'memory', 'short-term'), { recursive: true });
    mkdirSync(join(tmpDir, 'memory', 'long-term'), { recursive: true });
    writeFileSync(join(tmpDir, 'memory', 'short-term', 'last-dream.md'),
      '# Last Dream\n\nlast_dream_at: 2026-04-25T10:00:00Z\nsessions_since: 3\nstatus: ran\n');
    writeFileSync(join(tmpDir, 'memory', 'long-term', 'financial.md'), '# Financial\n\nSavings: 50k\n');

    // Others
    mkdirSync(join(tmpDir, 'inbox'), { recursive: true });
    writeFileSync(join(tmpDir, 'inbox', 'inbox.md'), '# Inbox\n\n- Random thought\n');
    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
    mkdirSync(join(tmpDir, 'journal'), { recursive: true });
    mkdirSync(join(tmpDir, 'core', 'protocols'), { recursive: true });
    mkdirSync(join(tmpDir, 'archive'), { recursive: true });
    mkdirSync(join(tmpDir, 'overrides'), { recursive: true });
    mkdirSync(join(tmpDir, 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, 'share'), { recursive: true });
  });

  after(() => { cleanTempDir(tmpDir); });

  it('migrates a v1 workspace to v2 structure', async () => {
    const { migrateV2InDir } = await import('../scripts/migrate-v2.js');
    await migrateV2InDir(tmpDir, PKG_ROOT);

    // v2 files exist
    assert.ok(fileExists(tmpDir, 'AGENTS.md'), 'AGENTS.md exists');
    assert.ok(fileExists(tmpDir, 'profile.md'), 'profile.md exists');
    assert.ok(fileExists(tmpDir, 'tasks.md'), 'tasks.md exists');
    assert.ok(fileExists(tmpDir, 'knowledge.md'), 'knowledge.md exists');
    assert.ok(fileExists(tmpDir, 'self-improvement.md'), 'self-improvement.md exists');
    assert.ok(fileExists(tmpDir, 'inbox.md'), 'inbox.md exists');
    assert.ok(fileExists(tmpDir, 'state', 'dream-state.md'), 'dream-state.md exists');
    assert.ok(fileExists(tmpDir, 'protocols', 'INDEX.md'), 'protocols/INDEX.md exists');

    // Profile content merged
    const profile = readText(tmpDir, 'profile.md');
    assert.ok(profile.includes('Kevin'), 'profile has identity content');
    assert.ok(profile.includes('Learn Rust'), 'profile has goals content');

    // Tasks merged
    const tasks = readText(tmpDir, 'tasks.md');
    assert.ok(tasks.includes('Ship v2'), 'tasks has work content');
    assert.ok(tasks.includes('Grocery run'), 'tasks has personal content');

    // Knowledge merged
    const knowledge = readText(tmpDir, 'knowledge.md');
    assert.ok(knowledge.includes('Dr. Smith'), 'knowledge has medical content');

    // Self-improvement merged
    const si = readText(tmpDir, 'self-improvement.md');
    assert.ok(si.includes('Fixed date format'), 'has corrections');
    assert.ok(si.includes('Working on v2'), 'has session handoff');

    // Long-term memory migrated
    assert.ok(knowledge.includes('Savings: 50k') || knowledge.includes('Migrated'), 'long-term memory migrated');

    // Dream state migrated
    const dreamState = readText(tmpDir, 'state', 'dream-state.md');
    assert.ok(dreamState.includes('2026-04-25'), 'dream state has last_dream_at');

    // Config updated
    const config = readJson(tmpDir, 'arc.config.json');
    assert.equal(config.version, '2.0.0');
    assert.equal(config.platform, 'claude-code');
    assert.ok(!config.features, 'features removed');

    // Old dirs gone
    assert.ok(!existsSync(join(tmpDir, 'core')), 'core/ removed');
    assert.ok(!existsSync(join(tmpDir, 'memory')), 'memory/ removed');
    assert.ok(!existsSync(join(tmpDir, 'overrides')), 'overrides/ removed');

    // Backup exists
    const archiveEntries = (await import('fs')).readdirSync(join(tmpDir, 'archive'));
    const preV2 = archiveEntries.find(e => e.startsWith('pre-v2-'));
    assert.ok(preV2, 'pre-v2 backup exists');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/migrate-v2.test.js`
Expected: FAIL — `migrateV2InDir` not exported.

- [ ] **Step 3: Write `scripts/migrate-v2.js`**

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { findConfig } from './lib/find-config.js';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function migrateV2(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  await migrateV2InDir(workspaceDir, pkgRoot);
}

export async function migrateV2InDir(workspaceDir, pkgRoot) {
  const configPath = join(workspaceDir, 'arc.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (config.version === '2.0.0') {
    console.log('Already on v2.');
    return;
  }

  console.log('Migrating to v2...');

  // Step 1: Full backup
  const date = new Date().toISOString().slice(0, 10);
  const backupDir = join(workspaceDir, 'archive', `pre-v2-${date}`);
  mkdirSync(backupDir, { recursive: true });

  const v1Dirs = [
    'core', 'profile', 'memory', 'todos', 'knowledge', 'decisions',
    'journal', 'inbox', 'skills', 'self-improvement', 'overrides', 'share',
  ];
  for (const dir of v1Dirs) {
    const src = join(workspaceDir, dir);
    if (existsSync(src)) {
      cpSync(src, join(backupDir, dir), { recursive: true });
    }
  }
  for (const file of ['CLAUDE.md', 'arc.config.json']) {
    const src = join(workspaceDir, file);
    if (existsSync(src)) cpSync(src, join(backupDir, file));
  }

  // Step 2: Consolidate user data
  const profileMd = mergeDirectory(join(workspaceDir, 'profile'), 'Profile');
  const tasksMd = mergeDirectory(join(workspaceDir, 'todos'), 'Tasks');
  const knowledgeMd = mergeKnowledge(join(workspaceDir, 'knowledge'));
  const decisionsMd = mergeChronological(join(workspaceDir, 'decisions'), 'Decisions');
  const journalMd = mergeChronological(join(workspaceDir, 'journal'), 'Journal');
  const selfImprovementMd = mergeSelfImprovement(join(workspaceDir, 'self-improvement'));
  const inboxMd = readIfExists(join(workspaceDir, 'inbox', 'inbox.md')) || '# Inbox\n';

  // Handle long-term memory -> knowledge migration
  const longTermDir = join(workspaceDir, 'memory', 'long-term');
  if (existsSync(longTermDir)) {
    const ltContent = collectMdFiles(longTermDir);
    if (ltContent.trim()) {
      const migratedSection = '\n\n## Migrated (review needed)\n\n' + ltContent;
      const kLines = knowledgeMd + migratedSection;
      writeFileSync(join(workspaceDir, 'knowledge.md'), kLines);
    } else {
      writeFileSync(join(workspaceDir, 'knowledge.md'), knowledgeMd);
    }
  } else {
    writeFileSync(join(workspaceDir, 'knowledge.md'), knowledgeMd);
  }

  writeFileSync(join(workspaceDir, 'profile.md'), profileMd);
  writeFileSync(join(workspaceDir, 'tasks.md'), tasksMd);
  writeFileSync(join(workspaceDir, 'decisions.md'), decisionsMd);
  writeFileSync(join(workspaceDir, 'journal.md'), journalMd);
  writeFileSync(join(workspaceDir, 'self-improvement.md'), selfImprovementMd);
  writeFileSync(join(workspaceDir, 'inbox.md'), inboxMd);

  // Handle short-term memory
  const shortTermDir = join(workspaceDir, 'memory', 'short-term');
  let dreamStateContent = '# Dream State\n\nlast_dream_at: null\nsessions_since: 0\nstatus: migrated\nlast_run_session: null\n\n## Last summary\n\nMigrated from v1.\n\n## Deferred items\n\n(none)\n';

  if (existsSync(shortTermDir)) {
    const lastDream = join(shortTermDir, 'last-dream.md');
    if (existsSync(lastDream)) {
      const content = readFileSync(lastDream, 'utf-8');
      const atMatch = content.match(/last_dream_at:\s*(.+)/);
      const sinceMatch = content.match(/sessions_since:\s*(\d+)/);
      const statusMatch = content.match(/status:\s*(.+)/);
      dreamStateContent = `# Dream State\n\nlast_dream_at: ${atMatch ? atMatch[1].trim() : 'null'}\nsessions_since: ${sinceMatch ? sinceMatch[1].trim() : '0'}\nstatus: ${statusMatch ? statusMatch[1].trim() : 'migrated'}\nlast_run_session: null\n\n## Last summary\n\nMigrated from v1.\n\n## Deferred items\n\n(none)\n`;
    }

    // Other short-term files -> inbox
    const stFiles = readdirSync(shortTermDir).filter(f => f !== 'last-dream.md' && f.endsWith('.md'));
    if (stFiles.length > 0) {
      let inboxAppend = '\n\n## Migrated from short-term memory\n\n';
      for (const f of stFiles) {
        const content = readFileContent(join(shortTermDir, f));
        if (content.trim()) inboxAppend += `### ${basename(f, '.md')}\n\n${content}\n\n`;
      }
      const currentInbox = readFileSync(join(workspaceDir, 'inbox.md'), 'utf-8');
      writeFileSync(join(workspaceDir, 'inbox.md'), currentInbox + inboxAppend);
    }
  }

  // Step 3: Create state directory
  mkdirSync(join(workspaceDir, 'state', 'locks'), { recursive: true });
  writeFileSync(join(workspaceDir, 'state', 'dream-state.md'), dreamStateContent);

  const templatesDir = join(pkgRoot, 'templates');
  cpSync(join(templatesDir, 'state', 'sessions.md'), join(workspaceDir, 'state', 'sessions.md'));

  // Step 4: Create system files from templates
  for (const file of ['AGENTS.md', 'startup.md', 'capture-rules.md']) {
    cpSync(join(templatesDir, file), join(workspaceDir, file));
  }

  // Step 5: Copy v2 protocols
  const protocolsDest = join(workspaceDir, 'protocols');
  if (existsSync(protocolsDest)) rmSync(protocolsDest, { recursive: true });
  cpSync(join(templatesDir, 'protocols'), protocolsDest, { recursive: true });

  // Step 6: Platform pointer
  const platform = config.platform || 'claude-code';
  const platformConfig = PLATFORMS[platform];
  if (platformConfig?.pointerFile) {
    writeFileSync(join(workspaceDir, platformConfig.pointerFile), platformConfig.pointerContent);
  }

  // Step 7: Generate integrations.md
  const integrations = Array.isArray(config.integrations)
    ? config.integrations.filter(i => typeof i === 'string')
    : [];
  writeFileSync(join(workspaceDir, 'integrations.md'), generateIntegrationsMd(platform, integrations));

  // Step 8: Transform config
  const newConfig = {
    version: '2.0.0',
    initialized: config.initialized ?? true,
    platform,
    user: config.user || { name: null, timezone: null, email: null },
    assistant: config.assistant || { name: 'Arc' },
    integrations,
  };
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n');

  // Step 9: Remove old structure
  for (const dir of v1Dirs) {
    const p = join(workspaceDir, dir);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // Ensure artifacts and archive dirs exist
  mkdirSync(join(workspaceDir, 'artifacts'), { recursive: true });
  mkdirSync(join(workspaceDir, 'archive'), { recursive: true });

  console.log(`Migration complete. Your pre-v2 workspace is backed up in archive/pre-v2-${date}/.`);
  console.log('Review the changes with `git diff` and commit when satisfied.');
  console.log('Long-term memory files were migrated to knowledge.md — review the "Migrated" section.');
}

function mergeDirectory(dirPath, title) {
  if (!existsSync(dirPath)) return `# ${title}\n`;

  const lines = [`# ${title}\n`];
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'TEMPLATE.md' && f !== 'README.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    const sectionName = basename(file, '.md');
    const capitalized = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
    lines.push(`\n## ${capitalized}\n`);
    lines.push(stripTopHeader(content));
  }

  return lines.join('\n') + '\n';
}

function mergeKnowledge(dirPath) {
  if (!existsSync(dirPath)) return '# Knowledge\n';

  const lines = ['# Knowledge\n'];
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'INDEX.md' || entry.name === 'README.md') continue;

    if (entry.isDirectory()) {
      const subDir = join(dirPath, entry.name);
      const subFiles = readdirSync(subDir).filter(f => f.endsWith('.md') && f !== 'README.md' && f !== 'INDEX.md');
      const capitalized = entry.name.charAt(0).toUpperCase() + entry.name.slice(1);
      lines.push(`\n## ${capitalized}\n`);
      for (const f of subFiles) {
        const content = readFileContent(join(subDir, f));
        if (!content.trim() || isEmptyTemplate(content)) continue;
        lines.push(stripTopHeader(content));
      }
    } else if (entry.name.endsWith('.md')) {
      const content = readFileContent(join(dirPath, entry.name));
      if (!content.trim() || isEmptyTemplate(content)) continue;
      const sectionName = basename(entry.name, '.md');
      const capitalized = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
      lines.push(`\n## ${capitalized}\n`);
      lines.push(stripTopHeader(content));
    }
  }

  return lines.join('\n') + '\n';
}

function mergeChronological(dirPath, title) {
  if (!existsSync(dirPath)) return `# ${title}\n\nAppend-only. Newest at the bottom.\n\n<!-- APPEND-ONLY below this line -->\n`;

  const lines = [`# ${title}\n\nAppend-only. Newest at the bottom.\n\n<!-- APPEND-ONLY below this line -->\n`];
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'TEMPLATE.md' && f !== 'README.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    lines.push(`\n### ${basename(file, '.md')}\n`);
    lines.push(stripTopHeader(content));
  }

  return lines.join('\n') + '\n';
}

function mergeSelfImprovement(dirPath) {
  if (!existsSync(dirPath)) return '# Self-Improvement\n\n## Corrections\n\n## Patterns\n\n## Session Handoff\n\n## Calibration\n';

  const sectionMap = {
    corrections: '## Corrections',
    feedback: '## Corrections',
    mistakes: '## Corrections',
    'observed-patterns': '## Patterns',
    'known-patterns': '## Patterns',
    patterns: '## Patterns',
    'session-handoff': '## Session Handoff',
    predictions: '## Calibration',
    'skill-usage': '## Calibration',
    wins: '## Calibration',
    'blind-spots': '## Patterns',
    'near-misses': '## Corrections',
    improvements: '## Patterns',
  };

  const sections = {
    '## Corrections': [],
    '## Patterns': [],
    '## Session Handoff': [],
    '## Calibration': [],
  };

  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
    .sort();

  for (const file of files) {
    const content = readFileContent(join(dirPath, file));
    if (!content.trim() || isEmptyTemplate(content)) continue;
    const key = basename(file, '.md');
    const section = sectionMap[key] || '## Corrections';
    sections[section].push(stripTopHeader(content));
  }

  const lines = ['# Self-Improvement\n'];
  for (const [header, contents] of Object.entries(sections)) {
    lines.push(`\n${header}\n`);
    for (const c of contents) {
      if (c.trim()) lines.push(c);
    }
  }

  return lines.join('\n') + '\n';
}

function readFileContent(filePath) {
  try { return readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function readIfExists(filePath) {
  try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function stripTopHeader(content) {
  return content.replace(/^#\s+.+\n+/, '');
}

function isEmptyTemplate(content) {
  const stripped = content.replace(/^#.+$/gm, '').replace(/<!--.*?-->/gs, '').trim();
  return stripped.length < 10;
}

function collectMdFiles(dirPath) {
  const lines = [];
  const files = readdirSync(dirPath).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const content = readFileContent(join(dirPath, f));
    if (content.trim() && !isEmptyTemplate(content)) {
      lines.push(`### ${basename(f, '.md')}\n\n${stripTopHeader(content)}`);
    }
  }
  return lines.join('\n\n');
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/migrate-v2.test.js`
Expected: All assertions PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-v2.js tests/migrate-v2.test.js
git commit -m "Add migrate-v2 script for v1 to v2 workspace conversion"
```

---

## Task 12: Delete old files + update README

**Files:**
- Delete: `user-data/` (entire directory)
- Delete: `core/` (entire directory)
- Delete: `scripts/generate-claude-md.js`
- Modify: `README.md`

- [ ] **Step 1: Delete old v1 directories and files**

Run:
```bash
rm -rf user-data/ core/ scripts/generate-claude-md.js
```

- [ ] **Step 2: Update `README.md`**

```markdown
# Arc Assistant

A self-improving personal assistant — portable across AI coding tools.

## Supported Platforms

- Claude Code
- Cursor
- Gemini CLI
- Codex
- Windsurf
- Antigravity

## Quick Start

```bash
npx arc-assistant init my-workspace
cd my-workspace
# Open in your AI coding tool — Arc will introduce itself
```

## Commands

| Command | Description |
|---------|-------------|
| `arc init [dir]` | Scaffold a new workspace |
| `arc configure` | Update config (name, timezone, platform, integrations) |
| `arc update` | Update system files and protocols |
| `arc rollback` | Restore from backup |
| `arc validate` | Check workspace integrity |
| `arc export` | Export user data as tar.gz |
| `arc reset` | Wipe user data to fresh templates |
| `arc migrate-v2` | One-time migration from v1 |
| `arc check-update` | Check for updates |

## Workspace Structure

```
workspace/
  AGENTS.md              <- AI instruction file
  profile.md             <- About the user
  tasks.md               <- Active tasks
  knowledge.md           <- Reference facts
  decisions.md           <- Decision log
  journal.md             <- Reflections
  self-improvement.md    <- Corrections, patterns, handoff
  inbox.md               <- Quick capture
  protocols/             <- Operational workflows
  state/                 <- Session registry, locks
  integrations.md        <- Available capabilities
```

## Privacy

This workspace may contain personal information. It is **local-only by default**:
- A pre-push git hook blocks all pushes to remote repositories
- All data stays on your machine
```

- [ ] **Step 3: Remove stale migrations directory if empty**

Run: `rm -f scripts/migrations/.gitkeep && rmdir scripts/migrations 2>/dev/null || true`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Remove v1 files (core/, user-data/, generate-claude-md.js), update README"
```

---

## Task 13: Run full test suite + verify scaffold

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `node --test tests/*.test.js`

Expected: All tests pass.

- [ ] **Step 2: Test `arc init` end-to-end**

Run:
```bash
TMPDIR=$(mktemp -d)
node bin/arc.js init "$TMPDIR/test-workspace" --platform claude-code --force
ls -la "$TMPDIR/test-workspace"
cat "$TMPDIR/test-workspace/arc.config.json"
cat "$TMPDIR/test-workspace/CLAUDE.md"
cat "$TMPDIR/test-workspace/AGENTS.md" | head -20
rm -rf "$TMPDIR"
```

Verify: workspace has all expected files, CLAUDE.md points to AGENTS.md, config has platform set.

- [ ] **Step 3: Test `arc validate` end-to-end**

Run:
```bash
TMPDIR=$(mktemp -d)
node bin/arc.js init "$TMPDIR/test-workspace" --platform claude-code --force
cd "$TMPDIR/test-workspace"
node /path/to/arc-assistant/bin/arc.js validate
cd -
rm -rf "$TMPDIR"
```

Expected: All checks pass.

- [ ] **Step 4: Verify package.json files list is correct**

Run: `npm pack --dry-run 2>&1 | head -40`

Verify: includes `bin/`, `templates/`, `scripts/` — does NOT include `core/`, `user-data/`, `tests/`.

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "Fix any issues found during end-to-end testing"
```

# Memory Intake Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Robin's subjective, unreliable memory capture with a concrete signal-pattern system, inbox-first tagged pipeline, inline checkpoint, and compaction-triggered sweep.

**Architecture:** All changes are protocol-layer (markdown files in `core/`) plus one line in `scripts/lib/platforms.js`. No new files, no CLI changes, no version bump. The capture system is expressed through updates to `capture-rules.md`, `startup.md`, `AGENTS.md`, `protocols/dream.md`, `self-improvement.md`, and `platforms.js`.

**Tech Stack:** Markdown protocol files, Node.js ES modules (platforms.js only), `node:test` + `node:assert/strict`

---

### Task 1: Restructure capture-rules.md — Checkpoint and Signal Patterns

The biggest change. Replace the subjective capture bar with concrete signal patterns and add the capture checkpoint directive. This task covers the top half of the file (new active system); Task 2 covers the pipeline/sweep; existing sections are preserved.

**Files:**
- Modify: `core/capture-rules.md:1-13` (replace capture bar, add checkpoint + signal patterns)

- [ ] **Step 1: Write the new checkpoint directive and signal patterns**

Replace lines 1–13 of `core/capture-rules.md` (everything from the title through the "Capture positive signals" bullet) with:

```markdown
# Capture Rules

## Capture checkpoint (ALWAYS READ)

After every response, scan the user's message and your response for capturable signals listed below. Write captures to `inbox.md` with tags (see Inbox-first pipeline). Direct-write corrections and explicit saves. This is what separates Robin from a stateless chatbot — don't skip it.

During multi-step tool-heavy work (implementing a feature, debugging across files), buffer captures mentally and batch-write them at the next natural break — after completing the immediate task, before moving to the next topic. The checkpoint runs as part of the same turn: compose your text response, then execute capture writes as tool calls.

## Signal patterns

### Always-capture

Write immediately, no judgment needed:

- User states a name + relationship ("my dentist is Dr. Park")
- User states a date or deadline ("we leave for Tokyo on June 3rd")
- User states a preference explicitly ("I prefer X over Y", "I don't like Z")
- User makes a decision with reasoning ("I'm going with Vanguard because...")
- User gives a correction ("no, that's wrong — it's actually...")
- User says "remember this" or equivalent explicit save request
- User shares a new recurring commitment ("I have PT every Tuesday")
- User states something that contradicts or supersedes known information ("I stopped going to that gym", "my new dentist is Dr. Chen")
- Robin produces analysis with durable insights (profile observations, pattern detection, inventories, gap analyses)

### Conditional-capture

Capture if the fact would change Robin's behavior or knowledge in a future session:

- Facts mentioned in passing that aren't the topic ("...since I moved to Jersey City...")
- Opinions and reactions with lasting relevance ("that restaurant was terrible")
- Health, financial, or legal details mentioned casually
- Work context changes ("I just got promoted", "we switched to Slack")
- User exhibits a repeated behavioral pattern across interactions (consistently prefers short responses, always chooses the detailed option, etc.)

### Never-capture

- Ephemeral task context ("let's use port 3000 for this")
- Code-specific decisions that live in the code itself
- Anything already captured — dedup against files currently in context; don't read files solely to check for duplicates
- Conversation mechanics ("yes", "go ahead", "sounds good") unless confirming a non-obvious preference or approach
```

- [ ] **Step 2: Verify the file structure**

Run: `head -50 core/capture-rules.md`

Expected: The file starts with `# Capture Rules`, then `## Capture checkpoint (ALWAYS READ)`, then `## Signal patterns` with three subsections. The old "Capture bar" section and its bullets are gone.

- [ ] **Step 3: Verify existing sections are preserved**

Run: `grep -n '## ' core/capture-rules.md`

Expected output should show the new sections at the top AND all existing sections still present: `## Routing`, `## Derived-analysis auto-capture`, `## Trip auto-creation`, `## Privacy (immutable)`, `## High-stakes confirmation`, `## Read-before-write`, `## Batch writes`, `## Index maintenance`.

- [ ] **Step 4: Commit**

```bash
git add core/capture-rules.md
git commit -m "feat(capture): replace subjective capture bar with concrete signal patterns"
```

---

### Task 2: Add Inbox-First Pipeline and Capture Sweep to capture-rules.md

Add the inbox-first pipeline (tag vocabulary, format, direct-write exceptions, confirmation behavior) and the capture sweep sections between the signal patterns and the existing routing table.

**Files:**
- Modify: `core/capture-rules.md` (insert after signal patterns, before routing table)

- [ ] **Step 1: Insert the inbox-first pipeline section**

After the `### Never-capture` section and before `## Routing`, insert:

```markdown

## Inbox-first pipeline

Most captures go to `inbox.md` as lightweight tagged entries. Dream routes them to the right destination within 24 hours. This keeps per-capture cost low — append one tagged line + index entry instead of navigating file structure.

### Format

```
- [tag] Content of the capture <!-- id:YYYYMMDD-HHMM-SSss -->
```

Examples:

```
- [fact] Dentist is Dr. Park, office in downtown JC <!-- id:20260427-1430-cc01 -->
- [preference] Prefers single bundled PRs over many small ones for refactors <!-- id:20260427-1430-cc02 -->
- [decision] Going with Vanguard target-date fund for 401k — expense ratio was the deciding factor <!-- id:20260427-1431-cc01 -->
- [correction] Don't summarize at the end of responses — user reads the diff <!-- id:20260427-1431-cc02 -->
- [update] Cancelled Orange Theory membership (supersedes: gym routine in profile) <!-- id:20260427-1432-cc01 -->
- [derived] Photography leans editorial — 60% of portfolio is environmental portraits <!-- id:20260427-1432-cc02 -->
```

### Tag vocabulary

| Tag | Dream routes to |
|-----|----------------|
| `[fact]` | `profile.md` or `knowledge.md` (Dream decides based on content) |
| `[preference]` | `self-improvement.md` → `## Preferences` |
| `[decision]` | `decisions.md` |
| `[correction]` | `self-improvement.md` → `## Corrections` |
| `[task]` | `tasks.md` |
| `[update]` | `profile.md` or `knowledge.md` (supersedes existing entry) |
| `[derived]` | Depends on content (Dream classifies) |
| `[trip]` | `trips/` |
| `[journal]` | `journal.md` |
| `[?]` | Unclassified — Dream treats as untagged, classifies from content |

Tags are routing hints, not binding. Dream uses the tag as a first-pass signal but verifies against the routing table. A bad tag doesn't misroute permanently.

### Multi-faceted moments

When a single moment contains multiple distinct facts, split into separate entries. Each entry is atomic — Dream routes each independently.

```
- [update] Dr. Park is no longer my dentist — office moved (supersedes: dentist in profile) <!-- id:... -->
- [fact] New dentist is Dr. Chen, office on Main St <!-- id:... -->
- [decision] Switched dentists because Dr. Park's office moved too far — proximity was the factor <!-- id:... -->
```

### `[update]` entries and supersedes hints

Update entries should include an optional `(supersedes: <hint>)` describing what they replace. Dream uses this hint to locate the original entry. Not required — Dream can search — but it speeds up resolution.

### Direct-write exceptions

These skip inbox and go to the destination file immediately:

- **Corrections** — `self-improvement.md` → `## Corrections`. The assistant needs to learn from them this session, not next Dream cycle.
- **Trip auto-creation** — already has its own protocol below, goes direct to `trips/`.
- **Explicit "remember this"** — user asked directly, so route to the confident destination and confirm.
- **Updates that contradict loaded context** — if the assistant knows the old fact is in a file it already read (e.g., profile.md loaded at startup), update it in place now. Don't wait for Dream.
- **Derived-analysis findings** — the assistant just performed the analysis and knows exactly where findings belong. Follow the derived-analysis auto-capture rules below.

### Confirmation behavior

| Capture type | User sees |
|-------------|-----------|
| Routine `[fact]`, `[preference]`, `[journal]` | Nothing (silent) |
| `[decision]`, `[correction]`, `[update]` | Brief inline parenthetical at end of response: *(noted — updated your dentist to Dr. Chen)* |
| High-stakes (medical, financial, legal) | Explicit verification before writing: "Just to make sure I have this right — [fact]?" |
| Explicit "remember this" | Confirmation of what was saved and where |
```

- [ ] **Step 2: Insert the capture sweep section**

After the confirmation behavior table and before `## Routing`, insert:

```markdown

## Capture sweep

Safety net for missed captures. The inline checkpoint degrades over long sessions as context compacts — the sweep catches what was missed.

### Triggers

**Primary — context compaction imminent.** When you receive a signal that context is about to compact (platform-specific — e.g., Claude Code shows a compaction warning), run a mini-sweep of the conversation window that's about to be lost. This is the most important trigger — once context compacts, the detail is gone. The mini-sweep is fast: scan for obvious signal hits, tag and append to inbox.md.

**Bonus — graceful session end.** When the user says goodbye or explicitly ends the session, run a full sweep of available context.

### Process

1. **Scan** — review available conversation context against signal patterns
2. **Cross-reference** — read `inbox.md` before each sweep to dedup against prior captures (prevents duplicates across multiple compaction events)
3. **Extract** — draft tagged inbox entries for anything missed
4. **Write** — batch-append all captures to `inbox.md`
5. **Handoff** — write a brief note to `self-improvement.md` → `## Session Handoff`: "Captured N items to inbox (breakdown by tag)."

### What the user sees

A single brief line, only if captures were made:

> *Captured 4 items to inbox before closing (2 facts, 1 preference, 1 update). Dream will route them next cycle.*

If nothing was captured, nothing is said.

### Scope limit

The sweep should take 30 seconds of assistant effort, not 5 minutes. Scan for signal pattern hits, write them, move on. If something is ambiguous, inbox it with a `[?]` tag and let Dream figure it out. The sweep operates on available context only — after compaction, conversation detail is gone.
```

- [ ] **Step 3: Update the routing table header**

Find the existing `## Routing` header and add a note that it's Dream's reference:

Change:
```markdown
## Routing
```

To:
```markdown
## Routing table (Dream reference)

Dream uses this table to route tagged inbox entries to their destination. The tag provides a first-pass signal; Dream verifies against this table.
```

- [ ] **Step 4: Remove the old capture bar section**

If any remnants of the old capture bar remain between `## Routing table (Dream reference)` and the routing table itself (the "Would a good human assistant..." paragraph, "Only persist facts useful in a future session" bullets, etc.), remove them. The signal patterns in the new sections replace this content entirely.

But keep the "Capture positive signals too" guidance — it's now expressed in the always-capture signals list ("Robin produces analysis with durable insights") and the conditional-capture list, so verify no orphaned bullets remain.

- [ ] **Step 5: Verify final structure**

Run: `grep -n '## ' core/capture-rules.md`

Expected section order:
1. `## Capture checkpoint (ALWAYS READ)`
2. `## Signal patterns`
3. `## Inbox-first pipeline`
4. `## Capture sweep`
5. `## Routing table (Dream reference)`
6. `## Derived-analysis auto-capture`
7. `## Trip auto-creation`
8. `## Privacy (immutable)`
9. `## High-stakes confirmation`
10. `## Read-before-write`
11. `## Batch writes`
12. `## Index maintenance`

- [ ] **Step 6: Commit**

```bash
git add core/capture-rules.md
git commit -m "feat(capture): add inbox-first pipeline, tag vocabulary, and capture sweep"
```

---

### Task 3: Update startup.md with Capture Checkpoint and Sweep Steps

Add two new steps to the startup sequence: the capture checkpoint directive (step 6) and the capture sweep directive (step 7). Renumber the existing "Respond to user" step to 8.

**Files:**
- Modify: `core/startup.md:13-15` (after "Read context", before "Respond to user")

- [ ] **Step 1: Add steps 6 and 7, renumber step 6 to 8**

In `core/startup.md`, find:

```markdown
6. **Respond to user**
```

Replace with:

```markdown
6. **Capture checkpoint** — after every response, run the capture signal scan from `capture-rules.md`. Scan for facts, preferences, decisions, corrections, updates, contradictions, and derived insights. Write captures to `inbox.md` with tags (or direct-write for exceptions). This is not optional — it is the primary mechanism that keeps Robin's memory current. During complex multi-step work, buffer captures and batch-write at the next natural break.

7. **Capture sweep** — when context compaction is imminent, run a mini-sweep of the about-to-be-lost context for missed captures. At graceful session end, run a full sweep if the session involved meaningful conversation. See `capture-rules.md` → Capture sweep for the full process.

8. **Respond to user**
```

- [ ] **Step 2: Verify the startup sequence**

Run: `grep -n '^\d\.' core/startup.md`

Expected: Steps numbered 1 through 8, with step 6 being "Capture checkpoint", step 7 being "Capture sweep", and step 8 being "Respond to user".

- [ ] **Step 3: Commit**

```bash
git add core/startup.md
git commit -m "feat(capture): add capture checkpoint and sweep to startup sequence"
```

---

### Task 4: Update AGENTS.md — Compaction-Proof Capture Anchor

Replace the existing `## Passive Capture` section with the new `## Capture` section that's self-contained enough to act on without re-reading capture-rules.md. This is the compaction-proof anchor — AGENTS.md is always in context because all platform pointer files say "Read and follow AGENTS.md".

**Files:**
- Modify: `core/AGENTS.md:62-64` (replace Passive Capture section)

- [ ] **Step 1: Replace the Passive Capture section**

In `core/AGENTS.md`, find:

```markdown
## Passive Capture

Read and follow `capture-rules.md`. Capture significant facts into the right file AS they surface — silently, same turn, never announce.
```

Replace with:

```markdown
## Capture

After every response, scan for capturable signals: facts, preferences, decisions, corrections, updates, contradictions. Write captures to `inbox.md` with tags — Dream routes them. Direct-write corrections and explicit saves. See `capture-rules.md` for the full signal list and tag vocabulary.

When context compaction is imminent, sweep the conversation for missed captures before the detail is lost.
```

- [ ] **Step 2: Verify AGENTS.md**

Run: `grep -n '## ' core/AGENTS.md`

Expected: `## Capture` appears where `## Passive Capture` used to be. No duplicate sections.

- [ ] **Step 3: Commit**

```bash
git add core/AGENTS.md
git commit -m "feat(capture): replace Passive Capture with compaction-proof Capture anchor in AGENTS.md"
```

---

### Task 5: Update protocols/dream.md — Tag Awareness and Capture Summaries

Update Dream's Phase 2 inbox routing to use tags as first-pass routing signals, and update Phase 3 session reflection processing to factor in capture sweep summaries.

**Files:**
- Modify: `core/protocols/dream.md:56-61` (Phase 2 inbox routing)
- Modify: `core/protocols/dream.md:77-78` (Phase 3 step 7)

- [ ] **Step 1: Update Phase 2 inbox routing**

In `core/protocols/dream.md`, find the Phase 2 inbox routing step:

```markdown
1. **Inbox routing** — for each entry in `inbox.md`:
   - Classify per `capture-rules.md` routing table
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE
```

Replace with:

```markdown
1. **Inbox routing** ��� for each entry in `inbox.md`:
   - If the entry has a tag (e.g., `[fact]`, `[preference]`), use it as a first-pass routing signal. Verify against `capture-rules.md` routing table — tags are hints, not binding.
   - `[?]` tagged entries: treat as unclassified, classify from content.
   - `[update]` tagged entries: use `(supersedes: <hint>)` if present to locate the original entry. Update the original, then remove the inbox item.
   - Untagged entries: classify per `capture-rules.md` routing table as before.
   - Confident match -> move to destination file, delete from inbox
   - Ambiguous -> leave in inbox, ESCALATE
   - Time-sensitive (deadline <=14d) -> route AND ESCALATE
```

- [ ] **Step 2: Update Phase 3 session reflection processing**

In `core/protocols/dream.md`, find step 7:

```markdown
7. **Session reflection processing** — scan `## Session Reflections` written since last dream. Extract knowledge gaps and add to `## Learning Queue`. Note domains touched and feed into `## Domain Confidence`. Prune reflections older than 30 days.
```

Replace with:

```markdown
7. **Session reflection processing** — scan `## Session Reflections` written since last dream. Also scan `## Session Handoff` for capture sweep summaries ("Captured N items to inbox...") — these are data points about session capture quality. Extract knowledge gaps and add to `## Learning Queue`. Note domains touched and feed into `## Domain Confidence`. Prune reflections older than 30 days.
```

- [ ] **Step 3: Verify the changes**

Run: `grep -n 'tag\|Tag\|supersedes\|capture sweep' core/protocols/dream.md`

Expected: Tag-related content appears in Phase 2, capture sweep reference appears in Phase 3 step 7.

- [ ] **Step 4: Commit**

```bash
git add core/protocols/dream.md
git commit -m "feat(capture): add tag-aware inbox routing and capture summary processing to Dream"
```

---

### Task 6: Update self-improvement.md Template — Session Handoff Awareness

Add a note to the Session Handoff section indicating that the capture sweep writes summaries there.

**Files:**
- Modify: `core/self-improvement.md:19-23` (Session Handoff section)

- [ ] **Step 1: Update Session Handoff description**

In `core/self-improvement.md`, find:

```markdown
## Session Handoff

Rolling notes for the next session. Newest entry at the top.

<!-- APPEND-ONLY below -->
```

Replace with:

```markdown
## Session Handoff

Rolling notes for the next session. Newest entry at the top. The capture sweep writes a brief summary here at session end: "Captured N items to inbox (breakdown by tag). [Any context the next session needs]."

<!-- APPEND-ONLY below -->
```

- [ ] **Step 2: Verify**

Run: `grep -A2 'Session Handoff' core/self-improvement.md`

Expected: The section description mentions the capture sweep summary.

- [ ] **Step 3: Commit**

```bash
git add core/self-improvement.md
git commit -m "feat(capture): add capture sweep summary note to Session Handoff template"
```

---

### Task 7: Update platforms.js — Pointer File Capture Anchor

Update the `pointerContent` for all platforms that have pointer files to append the capture anchor. This ensures new workspaces get the compaction-proof instruction in the pointer file as well as in AGENTS.md.

**Files:**
- Modify: `scripts/lib/platforms.js:1-36` (PLATFORMS object)

- [ ] **Step 1: Write the failing test**

Create `tests/platforms.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS } from '../scripts/lib/platforms.js';

describe('platform pointer content', () => {
  it('includes capture anchor in all pointer files', () => {
    for (const [name, config] of Object.entries(PLATFORMS)) {
      if (config.pointerContent) {
        assert.ok(
          config.pointerContent.includes('capturable signals'),
          `${name} pointer file should include capture anchor`
        );
        assert.ok(
          config.pointerContent.includes('inbox.md'),
          `${name} pointer file should reference inbox.md`
        );
      }
    }
  });

  it('preserves AGENTS.md reference in all pointer files', () => {
    for (const [name, config] of Object.entries(PLATFORMS)) {
      if (config.pointerContent) {
        assert.ok(
          config.pointerContent.includes('AGENTS.md'),
          `${name} pointer file should still reference AGENTS.md`
        );
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/platforms.test.js`

Expected: FAIL — "claude-code pointer file should include capture anchor"

- [ ] **Step 3: Update pointerContent in platforms.js**

In `scripts/lib/platforms.js`, update each platform's `pointerContent` that currently has a value. Change from:

```javascript
pointerContent: 'Read and follow AGENTS.md for all instructions.\n',
```

To:

```javascript
pointerContent: 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to inbox.md with tags.\n',
```

Apply this to all four platforms that have pointer files: `claude-code`, `cursor`, `gemini-cli`, `windsurf`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/platforms.test.js`

Expected: PASS — both tests pass.

- [ ] **Step 5: Run full test suite**

Run: `node --test`

Expected: All tests pass (existing + 2 new). Check that `init.test.js` still passes — the pointer file content changed but the test only checks `pointer.includes('AGENTS.md')` which is still true.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/platforms.js tests/platforms.test.js
git commit -m "feat(capture): add capture anchor to platform pointer file content"
```

---

### Task 8: Integration Test — Full Init Produces Updated Capture System

Verify that a freshly scaffolded workspace contains all the new capture system elements: the restructured capture-rules.md, the updated startup.md, the compaction-proof AGENTS.md anchor, and the pointer file capture line.

**Files:**
- Modify: `tests/init.test.js` (add one integration test)

- [ ] **Step 1: Add the integration test**

Add the following test to the existing `describe('robin init', ...)` block in `tests/init.test.js`:

```javascript
  it('scaffolds updated capture system in new workspace', async () => {
    const { initWithOptions } = await import('../scripts/cli/init.js');
    const targetDir = join(tmpDir, 'capture-ws');
    await initWithOptions(targetDir, {
      force: true,
      platform: 'claude-code',
      name: 'Test User',
      timezone: 'UTC',
    }, PKG_ROOT);

    const captureRules = readFileSync(join(targetDir, 'capture-rules.md'), 'utf-8');
    assert.ok(captureRules.includes('## Capture checkpoint (ALWAYS READ)'), 'capture-rules.md has checkpoint section');
    assert.ok(captureRules.includes('### Always-capture'), 'capture-rules.md has always-capture signals');
    assert.ok(captureRules.includes('## Inbox-first pipeline'), 'capture-rules.md has inbox-first pipeline');
    assert.ok(captureRules.includes('## Capture sweep'), 'capture-rules.md has capture sweep');
    assert.ok(captureRules.includes('## Routing table (Dream reference)'), 'capture-rules.md has routing table for Dream');

    const startup = readFileSync(join(targetDir, 'startup.md'), 'utf-8');
    assert.ok(startup.includes('Capture checkpoint'), 'startup.md has capture checkpoint step');
    assert.ok(startup.includes('Capture sweep'), 'startup.md has capture sweep step');

    const agents = readFileSync(join(targetDir, 'AGENTS.md'), 'utf-8');
    assert.ok(agents.includes('## Capture'), 'AGENTS.md has Capture section');
    assert.ok(!agents.includes('## Passive Capture'), 'AGENTS.md no longer has Passive Capture');
    assert.ok(agents.includes('capturable signals'), 'AGENTS.md capture section is self-contained');

    const pointer = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8');
    assert.ok(pointer.includes('capturable signals'), 'pointer file includes capture anchor');

    const dream = readFileSync(join(targetDir, 'protocols', 'dream.md'), 'utf-8');
    assert.ok(dream.includes('[update]'), 'dream.md has tag-aware inbox routing');

    const si = readFileSync(join(targetDir, 'self-improvement.md'), 'utf-8');
    assert.ok(si.includes('capture sweep'), 'self-improvement.md Session Handoff mentions capture sweep');
  });
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/init.test.js`

Expected: All tests pass including the new integration test.

- [ ] **Step 3: Run full test suite**

Run: `node --test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/init.test.js
git commit -m "test: integration test for capture system in scaffolded workspace"
```

---

### Task 9: Propagate Changes to robin-personal

Update the user's active Robin workspace with the new capture system files.

**Files:**
- No code changes — CLI command execution only

- [ ] **Step 1: Run robin update on robin-personal**

```bash
cd /Users/iser/workspace/robin/robin-personal && node /Users/iser/workspace/robin/robin-assistant/bin/robin.js update
```

Expected: "Already on version 2.1.0" (since this is a protocol-only change with no version bump, but the system files will be updated). If update skips due to same version, manually copy the changed system files:

```bash
cp /Users/iser/workspace/robin/robin-assistant/core/capture-rules.md /Users/iser/workspace/robin/robin-personal/capture-rules.md
cp /Users/iser/workspace/robin/robin-assistant/core/startup.md /Users/iser/workspace/robin/robin-personal/startup.md
cp /Users/iser/workspace/robin/robin-assistant/core/AGENTS.md /Users/iser/workspace/robin/robin-personal/AGENTS.md
cp /Users/iser/workspace/robin/robin-assistant/core/protocols/dream.md /Users/iser/workspace/robin/robin-personal/protocols/dream.md
cp /Users/iser/workspace/robin/robin-assistant/core/self-improvement.md /Users/iser/workspace/robin/robin-personal/self-improvement.md
```

**Important:** Do NOT overwrite `self-improvement.md` with the template if robin-personal already has content in it. Instead, only update the Session Handoff section description. Read the file first and edit surgically.

- [ ] **Step 2: Verify capture-rules.md in robin-personal**

```bash
grep -c '## Capture checkpoint' /Users/iser/workspace/robin/robin-personal/capture-rules.md
```

Expected: `1`

- [ ] **Step 3: Verify AGENTS.md in robin-personal**

```bash
grep '## Capture' /Users/iser/workspace/robin/robin-personal/AGENTS.md
```

Expected: Shows `## Capture` (not `## Passive Capture`).

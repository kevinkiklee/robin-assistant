# Memory Intake Improvement — Design Spec

## Problem

Robin's capture system is well-architected on paper but underperforms in practice. In the user's active workspace: journal.md has zero entries, self-improvement.md has 2 corrections and empty preferences, decisions.md has 1 entry, and knowledge.md is mostly empty scaffolding. The assistant misses facts that surface naturally in conversation AND sometimes fails to persist things the user explicitly asks it to save.

**Root causes:**

1. **Detection is subjective.** The capture bar ("would a good human assistant remember this?") requires judgment that varies by model and degrades over long sessions.
2. **Mechanics are heavy.** Each capture requires routing to the right file, finding the right section, formatting correctly, generating an index entry — 4-5 steps that create friction.
3. **Instructions aren't persistent.** Capture-rules.md is read at startup but its content compacts out of context in long sessions. The assistant literally forgets to capture.

## Solution

A three-layer capture system: concrete signal patterns replace subjective judgment, an inbox-first pipeline lowers write friction, and a compaction-triggered sweep catches what inline capture misses. No new files — everything integrates into the existing structure.

## Design

### 1. Capture Signal Patterns

Replace the subjective capture bar with concrete, scannable signal patterns.

#### Always-capture signals

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

#### Conditional-capture signals

Capture if the fact would change Robin's behavior or knowledge in a future session:

- Facts mentioned in passing that aren't the topic ("...since I moved to Jersey City...")
- Opinions and reactions with lasting relevance ("that restaurant was terrible")
- Health, financial, or legal details mentioned casually
- Work context changes ("I just got promoted", "we switched to Slack")
- User exhibits a repeated behavioral pattern across interactions (consistently prefers short responses, always chooses the detailed option, etc.)

#### Never-capture signals

- Ephemeral task context ("let's use port 3000 for this")
- Code-specific decisions that live in the code itself
- Anything already captured — dedup against files currently in context; don't read files solely to check for duplicates
- Conversation mechanics ("yes", "go ahead", "sounds good") unless confirming a non-obvious preference or approach

### 2. Inbox-First Pipeline

Most captures go to `inbox.md` as lightweight tagged entries. Dream routes them to the right destination within 24 hours.

#### Format

```markdown
- [tag] Content of the capture <!-- id:YYYYMMDD-HHMM-SSss -->
```

Examples:

```markdown
- [fact] Dentist is Dr. Park, office in downtown JC <!-- id:20260427-1430-cc01 -->
- [preference] Prefers single bundled PRs over many small ones for refactors <!-- id:20260427-1430-cc02 -->
- [decision] Going with Vanguard target-date fund for 401k — expense ratio was the deciding factor <!-- id:20260427-1431-cc01 -->
- [correction] Don't summarize at the end of responses — user reads the diff <!-- id:20260427-1431-cc02 -->
- [update] Cancelled Orange Theory membership (supersedes: gym routine in profile) <!-- id:20260427-1432-cc01 -->
- [derived] Photography leans editorial — 60% of portfolio is environmental portraits <!-- id:20260427-1432-cc02 -->
```

#### Tag vocabulary

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

#### Multi-faceted moments

When a single moment contains multiple distinct facts, split into separate entries. "I switched dentists because Dr. Park moved too far — my new dentist is Dr. Chen on Main St" becomes:

```markdown
- [update] Dr. Park is no longer my dentist — office moved (supersedes: dentist in profile) <!-- id:... -->
- [fact] New dentist is Dr. Chen, office on Main St <!-- id:... -->
- [decision] Switched dentists because Dr. Park's office moved too far — proximity was the factor <!-- id:... -->
```

Each entry is atomic. Dream routes each independently.

#### `[update]` entries and supersedes hints

Update entries should include an optional `(supersedes: <hint>)` describing what they replace. Dream uses this hint to locate the original entry. Not required — Dream can search — but it speeds up resolution.

#### Direct-write exceptions

These skip inbox and go to the destination file immediately:

- **Corrections** — `self-improvement.md` → `## Corrections`. The assistant needs to learn from them this session, not next Dream cycle.
- **Trip auto-creation** — already has its own protocol in capture-rules.md, goes direct to `trips/`.
- **Explicit "remember this"** — user asked directly, so route to the confident destination and confirm.
- **Updates that contradict loaded context** — if the assistant knows the old fact is in a file it already read (e.g., profile.md loaded at startup), update it in place now. Don't wait for Dream.
- **Derived-analysis findings** — the assistant just performed the analysis and knows exactly where findings belong. Follow the existing derived-analysis auto-capture rules in capture-rules.md.

#### Confirmation behavior

| Capture type | User sees |
|-------------|-----------|
| Routine `[fact]`, `[preference]`, `[journal]` | Nothing (silent) |
| `[decision]`, `[correction]`, `[update]` | Brief inline parenthetical at end of response: *(noted — updated your dentist to Dr. Chen)* |
| High-stakes (medical, financial, legal) | Explicit verification before writing: "Just to make sure I have this right — [fact]?" |
| Explicit "remember this" | Confirmation of what was saved and where |

### 3. Inline Capture Checkpoint

The mechanism that makes the assistant actually execute the signal scan.

#### How it works

As part of the same turn, after composing the text response, the assistant:

1. **Scans** the user's message and its own response against the signal patterns (Section 1)
2. **Extracts** a one-line tagged inbox entry for each signal hit
3. **Writes** entries to `inbox.md` (or direct-write for exceptions) as tool calls after the text response
4. **Confirms** per the confirmation behavior table — inline parenthetical for decisions/corrections/updates, silent for routine captures

#### Batching during complex work

During multi-step tool-heavy work (implementing a feature, debugging across files), the assistant should not interleave inbox.md writes between every tool call. Instead: buffer captures mentally and batch-write them at the next natural break — after completing the immediate task, before moving to the next topic.

#### Degradation over long sessions

The inline checkpoint will degrade as context compacts and the startup instructions fade. This is expected. The capture sweep (Section 4) exists to catch what the checkpoint misses. The compaction-proof anchor in AGENTS.md (Section 5) mitigates this by keeping the core instruction in context through compaction.

### 4. Capture Sweep

The safety net for missed captures. Two triggers, in order of importance.

#### Primary trigger: context compaction imminent

When the assistant receives a signal that context is about to compact (platform-specific — e.g., Claude Code shows a compaction warning, other platforms may surface similar signals), it runs a mini-sweep of the conversation window that's about to be lost. This is the most important trigger — once context compacts, the detail is gone.

The mini-sweep is fast: scan for obvious signal hits in the about-to-be-lost context, tag and append to inbox.md. Not thorough — just grab what's clearly capturable.

Read inbox.md before each sweep to dedup against prior sweep captures (prevents duplicates across multiple compaction events in a long session).

#### Bonus trigger: graceful session end

When the user says goodbye or explicitly ends the session, run a full sweep of available context:

1. **Scan** — review available conversation context against signal patterns
2. **Cross-reference** — check against inbox.md and other loaded files to avoid duplicates
3. **Extract** — draft tagged inbox entries for anything missed
4. **Write** — batch-append all captures to inbox.md
5. **Handoff** — write a brief note to `self-improvement.md` → `## Session Handoff`: "Captured N items to inbox (breakdown by tag). [Any context the next session needs]."

#### What the user sees

A single brief line, only if captures were made:

> *Captured 4 items to inbox before closing (2 facts, 1 preference, 1 update). Dream will route them next cycle.*

If nothing was captured, nothing is said.

#### Scope limit

The sweep should take 30 seconds of assistant effort, not 5 minutes. Scan for signal pattern hits, write them, move on. If something is ambiguous, inbox it with a `[?]` tag and let Dream figure it out.

#### Important: the sweep operates on available context

After compaction, conversation detail is gone. The sweep can only work with what's currently in context — not the full transcript. This is why the compaction-triggered sweep matters most: it catches content before it disappears.

### 5. Changes to Existing Files

#### `capture-rules.md` — major restructure

New structure (active system first, reference material second):

```
# Capture Rules

## Capture checkpoint (ALWAYS READ)
3-sentence directive: run signal scan after every response, write to inbox,
don't skip.

## Signal patterns
### Always-capture
### Conditional-capture
### Never-capture

## Inbox-first pipeline
### Format
### Tag vocabulary
### Direct-write exceptions
### Confirmation behavior

## Capture sweep
### Triggers
### Process
### Scope limit

## Routing table (Dream reference)
[existing — unchanged]

## Derived-analysis auto-capture
[existing — unchanged]

## Trip auto-creation
[existing — unchanged]

## Privacy (immutable)
[existing — unchanged]

## High-stakes confirmation
[existing — unchanged]

## Read-before-write
[existing — unchanged]

## Batch writes
[existing — unchanged]

## Index maintenance
[existing — unchanged]
```

The file leads with the active capture system (checkpoint → signals → pipeline → sweep) and follows with reference material. The assistant reads top-down; the most important instructions come first. All existing sections preserved, untouched.

#### `startup.md` — two new steps

After "Read context" (current step 5), add:

- **Step 6: Capture checkpoint** — "After every response, run the capture signal scan from capture-rules.md. This is not optional."
- **Step 7: Capture sweep** — "When context compaction is imminent, run a capture sweep. At session end, run a full sweep if the session involved meaningful conversation."

Renumber existing "Respond to user" step.

#### `AGENTS.md` — compaction-proof anchor

Update the existing `## Passive Capture` section. Current:

```markdown
## Passive Capture

Read and follow `capture-rules.md`. Capture significant facts into the right file
AS they surface — silently, same turn, never announce.
```

New:

```markdown
## Capture

After every response, scan for capturable signals: facts, preferences, decisions,
corrections, updates, contradictions. Write captures to inbox.md with tags — Dream
routes them. Direct-write corrections and explicit saves. See capture-rules.md for
the full signal list and tag vocabulary.

When context compaction is imminent, sweep the conversation for missed captures
before the detail is lost.
```

This paragraph survives compaction because AGENTS.md is always in context (all platform pointer files say "Read and follow AGENTS.md"). It's self-contained enough to act on without re-reading capture-rules.md.

#### Platform pointer files — new workspace enhancement

Update `pointerContent` in `platforms.js` to append the capture anchor for new workspaces:

```
Read and follow AGENTS.md for all instructions.
After every response, scan for capturable signals and write to inbox.md with tags.
```

Existing workspaces get the instruction through the AGENTS.md update (propagated by `robin update`).

#### `protocols/dream.md` — Phase 2 updates

Inbox routing (Phase 2, step 1) gains tag awareness:

- Use the entry's tag as a first-pass routing signal
- Verify against the routing table — tags are hints, not binding
- Handle `[?]` tagged items as unclassified: classify from content
- Handle `[update]` tagged items: use `supersedes:` hint (if present) to locate original entry, update it, remove inbox item

#### `protocols/dream.md` — Phase 3 update

Session reflection processing (step 7) should factor in capture sweep summaries from Session Handoff. "Captured N items" is a data point about session quality — Dream can track capture patterns over time.

#### `self-improvement.md` template — minor

Session Handoff section gains awareness that the capture sweep writes a brief summary there: "Captured N items to inbox (breakdown by tag)."

### 6. What This Design Does NOT Change

- **No new files.** Everything integrates into existing structure.
- **No new protocols.** The capture checkpoint is a directive, not a multi-phase protocol.
- **No code changes to the CLI.** This is entirely protocol-layer (markdown files in `core/`).
- **No changes to the indexing system.** Inbox captures get index entries per the existing index maintenance rules in capture-rules.md.
- **No version bump.** Protocol-only changes propagate through `robin update` as system file updates.

### 7. Success Criteria

The design succeeds if:

- Inbox.md accumulates tagged entries between Dream cycles (currently empty)
- Journal.md gains session reflections (currently zero entries)
- Self-improvement.md preferences section populates over time (currently empty)
- The user stops needing to say "remember this" — captures happen silently
- The session-end sweep reports non-zero captures for substantive sessions

Future metric (deferred): Dream tracks capture counts in dream-state.md — average captures per session, trend over time.

## Scope

This design covers Sub-Project 2 of the memory management improvement initiative. It depends on Sub-Project 1 (Memory Indexing & Metadata Layer), which is complete. Sub-Projects 3 (Tiered Storage & Archiving) and 4 (Freshness & Accuracy Engine) are independent and not affected by this work.

## Files Changed

| File | Change |
|------|--------|
| `core/capture-rules.md` | Major restructure — signal patterns, inbox-first pipeline, checkpoint, sweep |
| `core/startup.md` | Add steps 6-7 (capture checkpoint, capture sweep) |
| `core/AGENTS.md` | Replace Passive Capture section with compaction-proof Capture anchor |
| `core/protocols/dream.md` | Phase 2 tag awareness, Phase 3 capture summaries |
| `core/self-improvement.md` | Session Handoff capture summary awareness |
| `scripts/lib/platforms.js` | Append capture anchor to `pointerContent` |

# Adaptive Self-Improvement Design

Robin's self-improvement system today is purely reactive: it logs mistakes, promotes them to patterns, and tracks calibration. This design adds proactive learning — Robin tracks what works, identifies its own knowledge gaps, builds a model of how to communicate with the user, and rates its own competence per domain.

## Goals

1. Robin learns from positive signals, not just corrections
2. Robin actively identifies and closes knowledge gaps about the user
3. Robin adapts its communication style per domain based on accumulated evidence
4. Robin self-rates its competence per area of the user's life and adjusts behavior accordingly

## Non-goals

- Adaptation log (cut for noise — weekly system maintenance check-in provides transparency instead)
- Auto-editing AGENTS.md or protocols based on learned behavior

---

## 1. Restructured self-improvement.md

The file grows from 4 sections to 9. Existing sections are unchanged or expanded; 5 new sections are added.

### Unchanged sections

**## Corrections** — what Robin got wrong and what to do instead. Append-only. Dream promotes recurring corrections to Patterns.

**## Patterns** — promoted from recurring corrections. Each pattern has recognition signals and counter-actions. Dream reviews effectiveness daily.

**## Session Handoff** — rolling notes for the next session. "Pick up where I left off" continuity. Unchanged — this is NOT the same as session reflections.

### New sections

**## Preferences**

Tracks what works well — positive signals and explicit likes/dislikes.

Each entry:
- What worked (or what the user explicitly wants)
- Domain (if domain-specific) or "general"
- Evidence (summarized, not verbatim quotes)
- Date

Captured silently during conversation from:
- User acceptance without pushback on a non-obvious approach
- Explicit positive signals ("yes exactly", "perfect", "keep doing that")
- Direct style requests ("just do it, don't ask", "more detail please")
- Domain-specific feedback ("for finances, give me exact numbers")

Resolution rules:
- Domain-specific entries override general ones
- When a correction contradicts a preference, the correction wins and the preference is narrowed to exclude that domain
- When recent signals contradict established preferences, Dream flags the contradiction and updates or removes the stale preference

**Immediate application rule:** when the user gives direct style feedback in-session ("stop asking", "be more detailed"), Robin applies it immediately for the rest of that session AND captures it as a preference. Dream promotes accumulated implicit signals; explicit feedback takes effect instantly.

Dream promotes stable preferences (3+ consistent signals for the same dimension) into Communication Style.

---

**## Session Reflections**

Meta-learning about Robin's own performance. Different from Session Handoff (which is about continuity) and Journal (which is about the user's life).

Each entry:
- Date
- What went well (1-2 lines)
- What was clumsy or slow (1-2 lines)
- Knowledge gaps exposed (things Robin didn't know but should have)
- Domains touched

**Timing:** Robin writes a reflection as part of its normal session wind-down — when the user signals they're wrapping up, when conversation naturally slows, or before a long pause. This is a live write, not a Dream task. Some sessions will end abruptly with no reflection — that's fine, reflections are opportunistic, not mandatory.

Dream processes existing reflections: feeds knowledge gaps into the Learning Queue, updates Domain Confidence from domains touched and effectiveness signals, and prunes reflections older than 30 days (insights have been absorbed into other sections by then).

---

**## Learning Queue**

A prioritized list of things Robin wants to understand better about the user.

Each entry:
- Question
- Why it matters (which domain, what it would improve)
- Date added
- Status: open | answered | dropped

Behavioral rules:
- Robin asks ONE question per session maximum, only at a natural moment
- Never as an opener, never when the user is mid-task or stressed
- If no natural moment arises, skip it entirely
- Robin frames questions conversationally, not as interrogation ("I noticed you manage several photo projects — do you have a standard culling workflow, or does it vary?")

Queue management (Dream):
- Adds items from session reflection knowledge gaps
- Scans recent journal entries and session handoffs for organically answered questions — marks them answered without Robin having to explicitly ask
- Drops items older than 60 days with no natural opportunity (they weren't important enough)

**Cold start:** After first-run setup (name + timezone collected), seed the Learning Queue with foundational questions:
1. "What does a typical week look like for you?"
2. "What are your main areas of responsibility — work, personal projects, etc.?"
3. "What are your current top goals or priorities?"
4. "How do you prefer to work with an assistant — hands-off until asked, or proactive?"
5. "Any topics where you'd want me to be especially careful or thorough?"

Robin works through these over the first few sessions, one per session. These accelerate the initial model-building without being an interrogation.

---

**## Communication Style**

Robin's learned model of how to interact with the user. Built up from Preferences over time.

**Base style** (applies everywhere unless overridden):
- Verbosity: terse | moderate | detailed
- Tone: casual | professional | match-context
- Explain vs Do: just do it | brief context | full explanation
- Pushback level: suggest | advocate | challenge

**Domain overrides** (only when behavior should differ from base):
- Format: `[domain]: [dimensions that differ]`
- Example: "health: verbosity=detailed, pushback=challenge"
- Example: "task management: verbosity=terse, explain=just do it"

Update rules:
- Dream promotes from Preferences when 3+ consistent signals exist for a dimension
- Domain-specific corrections create or update a domain override without changing the base style
- Starts empty — Robin uses default judgment until enough signal accumulates
- No guessing at initial values; Robin earns the model from evidence

---

**## Domain Confidence**

Robin's self-assessed competence per area of the user's life.

Each entry:
- Domain name
- Confidence: low | medium | high
- Basis (what evidence supports this rating)
- Last updated date

Behavioral effect:
- **high** — act autonomously, offer recommendations proactively, less hedging
- **medium** — normal behavior, balanced ask-vs-act (default for new domains)
- **low** — ask more, hedge recommendations, suggest the user verify independently

New domains always start at **medium**. Confidence moves based on:
- Effectiveness scores (user acted-on raises confidence; user pushed-back or revised lowers it)
- Corrections in that domain lower confidence
- Successful autonomous actions that the user accepted raise confidence

**Staleness:** if a domain hasn't appeared in any session for 90 days, confidence decays one level (high to medium; medium stays at medium). Rationale: Robin's *skill* hasn't degraded, but the user's *situation* in that domain may have changed. When a stale domain resurfaces, Robin should verify current state before advising confidently.

### Expanded section

**## Calibration**

Existing content (prediction accuracy by confidence band) plus:

**Effectiveness scoring:** When Robin gives a high-stakes recommendation (finance, health, legal, major decisions), it silently logs a one-line entry:
- Date, domain, what was recommended, confidence level, outcome: pending

In subsequent sessions, Dream infers outcomes from:
- User follow-up ("I went with your suggestion and...")
- Contradictory actions (user did the opposite)
- Silence after 30+ days (outcome: unknown)

Scored as: acted-on | pushed-back | revised | unknown. Aggregated by domain to feed Domain Confidence.

**Important:** These are inferences, not ground truth. Robin never claims certainty about outcomes it cannot directly observe.

**Sycophancy tracking:** Persistent (not just Dream-time). Robin logs disagreement instances. Dream checks: if disagreement count is zero since last dream, note it as a sycophancy signal.

---

## 2. Dream Phase 3 (revised)

Dream's self-improvement phase expands from 5 steps to 8. All steps always run. Steps with nothing to do (no new signals, no stale entries) are no-ops. Priority order determines what's already complete if Dream is interrupted mid-run.

```
Phase 3: Self-improvement (priority order)

5.  Correction promotion — 2+ similar corrections → pattern with 
    recognition signals and counter-action. Remove promoted corrections.

6.  Pattern review — for each pattern, check recent corrections and 
    journal entries. Is the counter-action working? Escalate if the 
    same mistake recurs despite the pattern.

7.  Session reflection processing — scan ## Session Reflections written 
    since last dream. Extract knowledge gaps → add to Learning Queue. 
    Note domains touched → feed Domain Confidence. Prune reflections 
    older than 30 days.

8.  Preference promotion — scan ## Preferences for dimensions with 3+ 
    consistent signals. Promote to ## Communication Style (base or 
    domain override). Check for contradictions between recent signals 
    and established preferences — update or narrow stale preferences. 
    Flag unresolvable contradictions in escalation report.

9.  Domain confidence update — review session reflections, effectiveness 
    scores, and corrections since last dream. Adjust confidence levels. 
    Decay domains not touched in 90+ days by one level.

10. Learning queue maintenance — add items from knowledge gaps in 
    session reflections. Scan recent journal entries and session 
    handoffs for organically answered questions, mark them answered. 
    Drop items older than 60 days that never found a natural moment.

11. Calibration update — update prediction accuracy for matured 
    predictions. Update effectiveness scores where outcomes can be 
    inferred from recent sessions. Disagreement/sycophancy check.

12. Session handoff cleanup — entries older than 14 days → archive 
    to journal or delete if resolved.
```

---

## 3. Startup changes

Step 4 currently reads `profile.md` and `self-improvement.md` (session handoff section). Expand to also read:

- **## Communication Style** — so Robin calibrates its interaction from the first message
- **## Domain Confidence** — so Robin knows where to be cautious vs. autonomous
- **## Learning Queue** — so Robin has its one question ready if a natural moment arises

These are small, structured sections — a few lines each. They directly affect how Robin behaves all session.

---

## 4. System Maintenance changes

Add one step to the weekly interactive review:

```
### 7. Communication style check-in

Present current ## Communication Style (base + domain overrides) to the 
user: "This is how I've been calibrating to you — anything off?"

Also present ## Domain Confidence: "Here's where I think I'm strong vs. 
where I'm less sure — does this match your experience?"

Revise based on feedback.
```

This is the transparency mechanism. Once a week, the user sees what Robin has learned about how to interact with them and where it thinks it's competent, and can correct either.

---

## 5. Capture rules changes

Add one row to the routing table:

```
| Positive signal about Robin's approach | self-improvement.md → ## Preferences |
```

Add to the capture bar guidance:

```
Capture positive signals too — not just mistakes. "Yes exactly", accepting 
a non-obvious approach without pushback, explicit style feedback ("just do 
it", "more detail please") are all preference data.
```

---

## 6. File changes summary

| File | Change |
|------|--------|
| `self-improvement.md` | Add 5 new sections (Preferences, Session Reflections, Learning Queue, Communication Style, Domain Confidence). Expand Calibration. |
| `protocols/dream.md` | Expand Phase 3 from 5 to 8 steps. |
| `startup.md` | Step 4 reads 3 additional sections from self-improvement.md. |
| `protocols/system-maintenance.md` | Add step 7: communication style and domain confidence check-in. |
| `capture-rules.md` | Add positive signal routing row and capture bar guidance. |
| `scripts/init.js` | Seed Learning Queue with 5 foundational questions on first init. |

No new files are created. All changes extend existing files.

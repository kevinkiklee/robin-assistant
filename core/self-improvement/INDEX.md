# Self-Improvement Index

Routing and pruning logic for the assistant's self-improvement system. Covers what to read when, where lessons go, how patterns promote, and when files get archived.

---

## Startup read priority

### Tier 1 — Always read (every session)
- `profile/personality.md` — voice and style
- `self-improvement/session-handoff.md` — continuity from prior session
- `memory/short-term/last-dream.md` — Dream state

### Tier 2 — Before high-stakes responses
- `core/self-improvement/failure-modes.md` — 13 LLM failure signatures
- `core/self-improvement/known-patterns.md` — universal tendency counter-actions
- `self-improvement/observed-patterns.md` — user-specific patterns learned over time

### Tier 3 — On demand
Everything else. Load only when the current task needs it.

---

## Retrospective (look back)

Where completed work is reviewed and lessons extracted.

| File | Purpose |
|---|---|
| `self-improvement/mistakes.md` | Logged errors — source for pattern promotion |
| `self-improvement/wins.md` | What worked well — source for methodology refinement |
| `self-improvement/corrections.md` | User corrections — highest-signal feedback |
| `self-improvement/feedback.md` | Structured user feedback and ratings |

---

## Active monitoring

Applied in real time, before sending responses.

| File | When to use |
|---|---|
| `core/self-improvement/failure-modes.md` | Before any response with facts, advice, or recommendations |
| `core/self-improvement/known-patterns.md` | Before high-stakes queries |
| `self-improvement/observed-patterns.md` | When task matches a known user-specific pattern |

---

## Detection validation

### Near-misses
`self-improvement/near-misses.md` — Situations where a failure mode was caught before it caused harm. Tracked separately from mistakes because near-misses validate that the detection system is working.

### Blind spots
`self-improvement/blind-spots.md` — Failure modes or patterns the detection system consistently misses. Identified via retrospective audits. Feeds into skill creation.

---

## Forward-looking

| File | Purpose |
|---|---|
| `self-improvement/predictions.md` | Verifiable forecasts logged for calibration |
| `self-improvement/improvements.md` | Proposed system improvements pending implementation |

---

## External signal

| File | Purpose |
|---|---|
| `self-improvement/feedback.md` | User ratings, explicit feedback, session grades |
| `self-improvement/corrections.md` | User corrections — overrides stored patterns |

---

## Operational tracking

| File | Purpose |
|---|---|
| `self-improvement/skill-usage.md` | Which skills are used, how often, how well |
| `self-improvement/session-handoff.md` | Cross-session continuity — what the next session needs to know |

---

## Lesson routing logic

| What was learned | Destination |
|---|---|
| Factual mistake (one-off) | `self-improvement/mistakes.md` |
| Factual mistake (high-stakes domain) | `self-improvement/mistakes.md` + promote to `self-improvement/observed-patterns.md` immediately |
| Recurring mistake (2+ occurrences) | Promote to `self-improvement/observed-patterns.md` |
| User explicitly corrects me | `self-improvement/corrections.md` + evaluate for pattern promotion |
| Near-miss (caught before harm) | `self-improvement/near-misses.md` |
| Privacy scan blocked a write | `self-improvement/near-misses.md` (pattern type only, never the content) |
| Something worked unusually well | `self-improvement/wins.md` |
| User gives explicit positive feedback | `self-improvement/wins.md` |
| Proposed system improvement | `self-improvement/improvements.md` |
| Methodology-level insight | New or updated skill file in `skills/` |
| Systematic blind spot | `self-improvement/blind-spots.md` + candidate skill |

---

## Pruning rules

1. **90-day archive:** entries in `mistakes.md`, `near-misses.md`, and `wins.md` older than 90 days with no downstream reference → archive to `archive/self-improvement/YYYY-MM/`
2. **200-line cap:** if any self-improvement file exceeds 200 lines, consolidate resolved/redundant entries and archive originals
3. **Tier 3 startup demotion:** if a file has been in Tier 2 startup reads for 30+ days with no triggered use, move to Tier 3

---

## Improvement loops

### mistakes → patterns
After logging any mistake: ask "Is this a one-off or a tendency?" High-blast-radius domains (finance, medical, legal, irreversible) → promote immediately. Low-stakes → promote after 2+ occurrences.

### Correction velocity
Track time between user correction and pattern promotion. Target: same session for high-stakes, within 2 sessions for low-stakes.

### Cross-session duplicates
During Dream consolidation: scan `mistakes.md` and `corrections.md` for duplicate entries (same root cause, different instances). Consolidate and promote.

### Improvement experiments
When an improvement is implemented (`improvements.md`), log it with a hypothesis and expected outcome. After 5 sessions, evaluate: did it change behavior? Update accordingly.

### Near-miss validation
Monthly: review `near-misses.md`. If the same FM or pattern recurs in near-misses, it means the detection system is catching it but not resolving it — consider strengthening the counter-action or adding a pre-response checklist step.

### Blind spots → skills
Entries in `blind-spots.md` that cluster around a domain → candidate for a new skill file. Blind spots that cluster around a failure mode → candidate for an enhanced counter-action in `failure-modes.md`.

### Sycophancy check
Monthly: review wins:mistakes ratio. If >10:1 and no user-initiated disagreements, flag as potential sycophancy. Review `corrections.md` for capitulations without re-examination.

### Adaptation rate
Quarterly: review observed-patterns.md entries older than 6 months. If still active and unchanged, either the pattern is genuinely persistent (fine) or the counter-action isn't working (investigate).

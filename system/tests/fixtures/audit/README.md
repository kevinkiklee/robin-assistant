# Audit Fixture Corpus

Sample file pairs that illustrate the patterns a weekly audit pass should flag.
These are **not** processed by `generateAuditPairs()` (which operates on the live
`user-data/memory/` tree). They exist for human inspection and as anchors for
future integration tests of the full LLM-pass flow.

## Pairs

### `contradiction-location/`

| File | Claim |
|------|-------|
| `profile-identity.md` | "Lives in New York City" |
| `knowledge-locations.md` | "Moved to Los Angeles in early 2025" |

**Expected audit output:** `contradiction` — mutually exclusive location claims.
Suggestion: update `profile-identity.md` to reflect the move; add a "Previous" entry.

---

### `contradiction-preference/`

| File | Claim |
|------|-------|
| `profile-personality.md` | "Strongly prefers terse, direct responses… dislikes step-by-step walkthroughs" |
| `self-improvement-preferences.md` | "Wants step-by-step explanations for technical topics" |

**Expected audit output:** `contradiction` — preference signals directly conflict.
Suggestion: reconcile into a domain-scoped rule (terse by default; step-by-step for technical).

---

### `redundant-fact/`

| File | Claim |
|------|-------|
| `profile-work.md` | "Senior Developer Relations Engineer at Google since 2019. Focuses on cloud-native tooling and developer education." |
| `knowledge-career.md` | Same paragraph verbatim |

**Expected audit output:** `redundancy` — identical fact duplicated across two files.
Suggestion: keep canonical copy in one file, replace the other with a forward reference.

---

### `no-issue/`

| File | Content |
|------|---------|
| `profile-routines.md` | Morning/evening routines |
| `knowledge-restaurants.md` | Restaurant list |

**Expected audit output:** no findings — unrelated topics, no overlapping claims.

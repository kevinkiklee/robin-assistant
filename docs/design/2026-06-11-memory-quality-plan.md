# Memory-Quality Pack (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One belief head per fact (canonicalized topics, similarity-gated merges), freshness re-queries that chase the riskiest stale heads instead of the first N, claim-extraction failures that retry instead of silently losing data, and entity profiles that can't serve 30-day-old text as current truth.

**Architecture:** C1 adds a deterministic `canonicalizeTopic()` layer inside `believe()` — the single belief-write choke point — with a levenshtein claim-similarity gate before any cross-slug supersession, plus lookup symmetry in `recallBelief()` and a one-time merge pass over existing duplicate heads (`robin beliefs canonicalize`). C2 rewrites `runBeliefFreshness`'s selection from first-N to risk-scored top-N. C3 adds a `claim_failures` dead-letter table (migration 026) fed by the biographer's claim-extraction failures and drained by a bounded retry pass with a Phase-A backlog alert. C4 adds `entities.profile_generated_at` (migration 027), stamps it at every profile write, regenerates stale profiles in the dream pass's spare budget, and nulls stale profiles out of the entity read surfaces with a deterministic relation-summary fallback.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 via `RobinDb`, `node:test` + `node:assert/strict` collocated tests, `levenshtein` from `system/lib/levenshtein.ts`, alert-store from Phase A.

**Spec:** `docs/design/2026-06-10-trust-feedback-memory-design.md` (Phase C, §C1–C4).

**Conventions for every task:** run a single test file with `pnpm exec tsx --test <file>`; full gates at the end are `pnpm lint && pnpm typecheck && pnpm test` (4 pre-existing failures are known and not ours: spotify ×2, ebird, recall). Commit after each task to `main`, author email `kevin.kik.lee@gmail.com`. The pre-commit hook auto-formats — **never `git add -A`** (the autonomous daemon edits this tree concurrently); always stage explicit paths.

**Decisions baked into this plan** (read before implementing; each is deliberate):

1. **Canonicalization is a second layer, not a replacement.** `normalizeTopic()` (belief.ts:64) stays as-is — it fixes STYLE (case/dots/spaces). The new `canonicalizeTopic()` fixes SEMANTIC fragmentation by stripping negation + modifier tokens from the normalized slug ("no-aerospace-internship", "aerospace-internship-claim" → "aerospace-internship"). Heads are STORED under the canonical slug going forward.
2. **The similarity gate applies only to implicit cross-slug merges.** Three supersession paths exist:
   - *Explicit supersedes* (freshness re-query, corrections-replay, retractions): caller-asserted, bypasses the gate entirely — a retraction's claim text legitimately differs wildly from the head it retracts.
   - *Implicit, same stored topic*: today's behavior, unchanged (re-stating a topic always supersedes its head).
   - *Implicit, cross-slug* (the head was found only because canonicalization mapped a DIFFERENT original slug onto it): gated by claim-text similarity (normalized levenshtein < 0.4 — looser than the 0.2 candidate-merge threshold because opposing claims about one fact differ by a negation word, and the slug match already did most of the work). Gate fails → no merge; the new claim is written under its own **plain-normalized** topic (false merges are worse than duplicates, spec §C1).
3. **Legacy heads (pre-canonical topics) are handled by lookup fallback + the one-time merge pass.** Until `robin beliefs canonicalize --apply` runs, old heads sit under non-canonical topics. `believe()` looks up the canonical slug first, then falls back to the plain-normalized input topic; `recallBelief()` does the same two-step. The explicit-supersedes topic-match validation compares CANONICAL forms so freshness re-confirmation of a legacy head doesn't throw. Residual risk (new write under canonical slug while an unmergeable legacy variant head exists) is closed by running the merge pass during finalize, immediately after deploy.
4. **Merge audit trail = `belief.canonicalize` events, permanent.** The spec says "log every merge decision to the journal for the first two weeks"; events are this codebase's audit-trail idiom (cf. `belief.stale`), they're queryable, and the nightly journal synthesis reads events anyway. We write one `belief.canonicalize` event per one-time-pass merge decision (including skipped-dissimilar groups) and include `original_topic` in the belief payload whenever `believe()` canonicalized a slug. No two-week toggle (YAGNI; the events are cheap and permanently useful). Deviation from spec letter, faithful to its intent — flagging it here.
5. **`extractClaims` currently can't distinguish "no claims in this chunk" from "the LLM output didn't parse"** (both return `[]`, biographer.ts:186). C3 requires the distinction, so its return type changes to `{ claims, failure?: string }`. Timeouts already throw (`withTimeout` → caught in the per-chunk catch, biographer.ts:1487).
6. **"Open" dead-letter = `attempts < 3`.** Rows that exhaust 3 attempts stay as audit (pruned after 30 days by the retry pass itself); the backlog alert counts only open rows. The alert (source `biographer`, key `claim-failures-backlog`) resolves when the open count drops to ≤ 10 — event-driven alerts must carry their own resolution path (Phase B's final review lesson).
7. **C4's read-side gate lives at the entity read boundary, not auto-recall.** Auto-recall injects only `belief.update`/`knowledge.doc` snippets (auto-recall.ts:52, `CURATED_RECALL_KINDS`) — it never serves entity profiles, so the spec's "auto-recall skips stale profiles" maps onto the surfaces that DO serve them: the `find_entity`, `get`, and `related_entities` MCP tools (all return `EntityRow.profile`). Stale profile → replaced with a deterministic relation summary (no LLM), built from the entity's most recent relations.
8. **Timestamp normalization (same rule as Phases A/B):** any SQL comparison between a stored timestamp and a JS ISO string goes through `datetime(col) >= datetime(?)` — `entities.updated_at`/`created_at`/`relations.ts` are sqlite-format, JS supplies ISO.

---

### Task 1: `canonicalizeTopic()` — deterministic semantic slug

**Files:**
- Modify: `system/brain/memory/belief.ts` (new exported function next to `normalizeTopic`)
- Test: `system/brain/memory/belief.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (table-driven, per spec testing section):

```typescript
test('canonicalizeTopic strips negation and modifier tokens', () => {
  const cases: Array<[string, string]> = [
    ['no-aerospace-internship', 'aerospace-internship'],
    ['aerospace-internship-claim', 'aerospace-internship'],
    ['aerospace-internship-status', 'aerospace-internship'],
    ['not-moving-to-sf', 'moving-to-sf'],
    ['kevins-current-employer', 'employer'],
    ['medications-ramelteon', 'medications-ramelteon'], // no stopwords → unchanged
    ['home-location', 'home-location'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalizeTopic(input), expected, input);
  }
});

test('canonicalizeTopic never returns empty — all-stopword slugs fall back to the input', () => {
  assert.equal(canonicalizeTopic('no-claim'), 'no-claim');
  assert.equal(canonicalizeTopic('current-status'), 'current-status');
});

test('canonicalizeTopic is idempotent', () => {
  const once = canonicalizeTopic('no-aerospace-internship-claim');
  assert.equal(canonicalizeTopic(once), once);
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/brain/memory/belief.test.ts`

- [ ] **Step 3: Implement** (in belief.ts, directly below `normalizeTopic`):

```typescript
/** Tokens that negate a claim without changing WHICH fact it is about. Stripping
 *  them is intentional (spec §C1): opposing claims about one fact belong on one
 *  head's supersession chain. */
const NEGATION_TOKENS = new Set([
  'no', 'not', 'never', 'non', 'isnt', 'doesnt', 'dont', 'without', 'false', 'denied',
]);
/** Style/meta tokens that fragment slugs without identifying a different fact. */
const MODIFIER_TOKENS = new Set([
  'claim', 'claims', 'status', 'update', 'updated', 'current', 'currently',
  'latest', 'new', 'recent', 'info', 'fact', 'belief', 'kevin', 'kevins', 'my',
]);

/**
 * Canonicalize an already-normalizeTopic'd slug down to its domain fact (spec
 * §C1): strip negation + modifier tokens so "no-aerospace-internship",
 * "aerospace-internship-claim" and "aerospace-internship" all key one head.
 * Deterministic, order-preserving, idempotent. Falls back to the input when
 * stripping would leave nothing — a slug must never canonicalize to ''.
 */
export function canonicalizeTopic(normalized: string): string {
  const kept = normalized
    .split('-')
    .filter((t) => t.length > 0 && !NEGATION_TOKENS.has(t) && !MODIFIER_TOKENS.has(t));
  if (kept.length === 0) return normalized;
  return kept.join('-');
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/belief.ts system/brain/memory/belief.test.ts
git commit -m "feat(beliefs): deterministic topic canonicalizer (negation/modifier stripping)"
```

---

### Task 2: `believe()` canonical supersession with similarity gate

**Files:**
- Modify: `system/brain/memory/belief.ts` (`believe()` body)
- Test: `system/brain/memory/belief.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (use the file's existing in-memory DB + `believe()` fixtures):

```typescript
test('opposing claim under a negated slug supersedes the same head', () => {
  const a = believe(db, null, { topic: 'aerospace-internship', claim: 'Kevin has an aerospace internship' });
  const b = believe(db, null, { topic: 'no-aerospace-internship', claim: 'Kevin does not have an aerospace internship' });
  assert.equal(b.supersededEventId, a.eventId); // one chain, not two heads
  assert.equal(b.topic, 'aerospace-internship'); // stored canonical
});

test('modifier slug variant supersedes the canonical head', () => {
  const a = believe(db, null, { topic: 'sf-move', claim: 'Kevin is moving to SF in July' });
  const b = believe(db, null, { topic: 'sf-move-status', claim: 'Kevin is moving to SF in August' });
  assert.equal(b.supersededEventId, a.eventId);
});

test('slug collision with dissimilar claim does NOT merge — falls back to the plain-normalized topic', () => {
  const a = believe(db, null, { topic: 'coffee', claim: 'Kevin drinks two espressos every morning' });
  // 'coffee-status' canonicalizes to 'coffee' but the claim is unrelated text:
  const b = believe(db, null, { topic: 'coffee-status', claim: 'The Chemex carafe cracked and was thrown out yesterday' });
  assert.equal(b.supersededEventId, null);
  assert.equal(b.topic, 'coffee-status'); // kept distinct — false merges are worse than duplicates
});

test('same stored topic always supersedes regardless of claim text (existing contract)', () => {
  const a = believe(db, null, { topic: 'coffee', claim: 'Kevin drinks two espressos every morning' });
  const b = believe(db, null, { topic: 'coffee', claim: 'Completely different text about coffee gear' });
  assert.equal(b.supersededEventId, a.eventId);
});

test('explicit supersedes bypasses the similarity gate (retraction path)', () => {
  const a = believe(db, null, { topic: 'no-aerospace-internship', claim: 'Kevin does not have an aerospace internship' });
  const r = believe(db, null, {
    topic: 'aerospace-internship', claim: '(retracted)', retracted: true, supersedes: a.eventId,
  });
  assert.equal(r.supersededEventId, a.eventId); // canonical-form topic match, no similarity check
});

test('canonicalized writes carry original_topic in the payload', () => {
  const b = believe(db, null, { topic: 'no-aerospace-internship', claim: 'x y z' });
  const raw = db.prepare(`SELECT json_extract(payload,'$.original_topic') AS o FROM events WHERE id=?`).get(b.eventId) as { o: string | null };
  assert.equal(raw.o, 'no-aerospace-internship');
});
```

(The dissimilar-claim test needs claims whose normalized levenshtein distance ≥ 0.4 — the two strings above are; verify in the test if in doubt by importing `levenshtein`.)

- [ ] **Step 2: Run to verify fail**, then implement. Changes inside `believe()` (current body at belief.ts:120–191):

```typescript
import { levenshtein } from '../../lib/levenshtein.ts';

/** Cross-slug merge gate (spec §C1): claims must be textually similar before a
 *  canonicalization-driven supersession is allowed. Looser than the candidate-
 *  merge 0.2 because opposing claims differ by a negation word and the slug
 *  match already established same-fact intent. */
const CANONICAL_MERGE_MAX_DIST = 0.4;

function claimsSimilar(a: string, b: string): boolean {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return false;
  if (Math.abs(a.length - b.length) / longer >= CANONICAL_MERGE_MAX_DIST) return false; // cheap short-circuit
  return levenshtein(a, b) / longer < CANONICAL_MERGE_MAX_DIST;
}
```

In the body, replace the single `topic` derivation and head lookup with:

```typescript
  const normalized = normalizeTopic(input.topic);
  if (!normalized) throw new Error('believe: topic required');
  const canonical = canonicalizeTopic(normalized);
  let topic = canonical;
```

The head lookup becomes a two-step (canonical first, then the plain-normalized legacy form), and the cross-slug gate decides the final `topic`:

```typescript
  const findHead = (t: string) =>
    db
      .prepare(
        `SELECT e.id AS id, c.body AS claim, json_extract(e.payload,'$.topic') AS topic
           FROM events e LEFT JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = ? AND json_extract(e.payload,'$.topic') = ?
            AND json_extract(e.payload,'$.external_id') != ?
          ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
      )
      .get(BELIEF_KIND, t, externalId) as { id: number; claim: string | null; topic: string } | undefined;

  let head = findHead(canonical);
  if (!head && normalized !== canonical) head = findHead(normalized);

  // Cross-slug merge gate (spec §C1): when the head was reached only through
  // canonicalization (its slug differs from the caller's plain-normalized one),
  // require claim-text similarity before superseding. Same-slug supersession
  // and explicit `supersedes` keep today's unconditional behavior.
  if (
    head &&
    input.supersedes == null &&
    normalized !== canonical &&
    head.topic !== normalized &&
    !claimsSimilar(head.claim ?? '', input.claim.trim())
  ) {
    head = undefined;
    topic = normalized; // keep the new claim distinct — false merges are worse than duplicates
  }
```

IMPORTANT ordering note: `externalId` is derived from `topic` (belief.ts:147–151) but the gate can change `topic` — derive `externalId` AFTER the gate, from the final `topic`. The `findHead` external-id exclusion exists to skip the row being upserted same-day; compute a provisional externalId from `canonical` for the lookup, then recompute from the final `topic` for the write (or restructure so externalId is computed once after the gate and the lookup uses a same-day exclusion on `belief:${date}:` prefix — pick the simpler correct form and keep the same-day idempotency tests passing).

The explicit-supersedes validation (belief.ts:170) compares canonical forms so legacy heads stay supersedable:

```typescript
    if (canonicalizeTopic(normalizeTopic(row.topic)) !== canonical)
      throw new Error('believe: supersedes topic mismatch');
```

The payload gains `original_topic` when canonicalization changed the slug:

```typescript
    payload: {
      topic,
      ...(topic !== normalized ? { original_topic: normalized } : {}),
      // ...existing fields unchanged
    },
```

- [ ] **Step 3: Run the WHOLE belief test file** — all pre-existing tests (same-day idempotency, retraction, supersession chain, dev-artifact block) must still pass. Then `pnpm exec tsx --test system/brain/cognition/dream.test.ts system/brain/cognition/belief-freshness.test.ts` — the promotion/freshness paths call `believe()` and must be unaffected.

- [ ] **Step 4: Commit**

```bash
git add system/brain/memory/belief.ts system/brain/memory/belief.test.ts
git commit -m "feat(beliefs): canonical supersession in believe() with cross-slug similarity gate"
```

---

### Task 3: `recallBelief()` lookup symmetry

**Files:**
- Modify: `system/brain/memory/belief.ts` (`recallBelief()` topic branch, belief.ts:209–224)
- Test: `system/brain/memory/belief.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('recall_belief resolves negated/modified query slugs to the canonical head', () => {
  believe(db, null, { topic: 'aerospace-internship', claim: 'Kevin has an aerospace internship' });
  const viaNegation = recallBelief(db, { topic: 'no-aerospace-internship' });
  const viaModifier = recallBelief(db, { topic: 'aerospace-internship-claim' });
  assert.ok(viaNegation && !Array.isArray(viaNegation));
  assert.equal(viaNegation.topic, 'aerospace-internship');
  assert.deepEqual(viaModifier, viaNegation);
});

test('recall_belief falls back to the plain-normalized topic for unmerged legacy heads', () => {
  // Simulate a legacy head stored under a non-canonical slug (pre-C1 data):
  // write it via raw ingest with topic 'coffee-status' (canonicalizes to 'coffee', but
  // no 'coffee' head exists), then query 'coffee-status' — must resolve.
  // Seed with believe() under a gated-fallback topic from Task 2's dissimilar case, or raw SQL.
  // assert recallBelief(db, { topic: 'coffee-status' }) finds it.
});

test('history mode follows the same two-step lookup', () => { /* canonical chain via negated query, history:true returns >1 rows */ });
```

Write the legacy-seed body concretely (raw `ingest()` with an explicit payload mirrors how pre-C1 heads exist).

- [ ] **Step 2: Run to verify fail**, then implement in the `opts.topic` branch:

```typescript
  if (opts.topic) {
    const normalized = normalizeTopic(opts.topic);
    const canonical = canonicalizeTopic(normalized);
    // Lookup symmetry (spec §C1): the same canonicalizer used at write time runs
    // on the query, so historical and future topic strings resolve to one head.
    // Fallback to the plain-normalized form covers legacy heads not yet swept by
    // `robin beliefs canonicalize` and gate-kept distinct topics.
    const lookup = (t: string) => { /* the existing single-topic query, parameterized by t */ };
    if (opts.history) {
      const rows = lookupHistory(canonical);
      if (rows.length > 0 || canonical === normalized) return rows.map(mapRow);
      return lookupHistory(normalized).map(mapRow);
    }
    const row = lookup(canonical) ?? (canonical !== normalized ? lookup(normalized) : undefined);
    return row ? mapRow(row) : null;
  }
```

(Express it with the file's existing prepared-statement style; the snippet shows intent, not literal code — factor the shared SQL once.)

- [ ] **Step 3: Run the whole belief test file; commit:**

```bash
git add system/brain/memory/belief.ts system/brain/memory/belief.test.ts
git commit -m "feat(beliefs): recall_belief canonical lookup symmetry with legacy fallback"
```

---

### Task 4: One-time merge pass + `robin beliefs canonicalize`

**Files:**
- Create: `system/brain/memory/canonicalize-heads.ts`
- Test: `system/brain/memory/canonicalize-heads.test.ts`
- Modify: `system/surfaces/cli/beliefs.ts` (new subcommand) + `system/surfaces/cli/index.ts` help text (beliefs line)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('groups live heads by canonical slug and merges similar-claim groups onto the newest head', () => {
  // Seed 3 live heads: 'aerospace-internship' (oldest), 'no-aerospace-internship',
  // 'aerospace-internship-claim' (newest) with near-identical claim texts.
  // run canonicalizeBeliefHeads(db, null, { apply: true })
  // assert: recallBelief enumerate shows ONE head for canonical 'aerospace-internship';
  // its claim is the newest head's claim; the two older chains end in superseding events
  // whose external_id starts with 'canonicalize:'.
});

test('dissimilar-claim groups are skipped and logged, not merged', () => {
  // Two heads whose slugs canonicalize together but claims are unrelated →
  // apply:true leaves both live; ONE belief.canonicalize event with decision:'skipped-dissimilar'.
});

test('dry-run (default) writes nothing', () => {
  // apply:false → returns the planned decisions, zero new events rows.
});

test('idempotent: a second apply run is a no-op', () => {});

test('E2E (spec): duplicate-topic promote → single head', () => {
  // believe() two style-variant slugs with similar claims (post-Task-2 these merge at
  // write time); then the pass finds nothing to do — proving write-time + sweep agree.
});
```

- [ ] **Step 2: Run to verify fail**, then implement:

```typescript
// system/brain/memory/canonicalize-heads.ts
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { levenshtein } from '../../lib/levenshtein.ts';
import { type BeliefRecord, believe, canonicalizeTopic, recallBelief } from './belief.ts';
import type { RobinDb } from './db.ts';
import { ingest } from './ingest.ts';

export interface CanonicalizeDecision {
  canonical: string;
  topics: string[];
  decision: 'merged' | 'skipped-dissimilar';
  winnerEventId?: number;
}

export interface CanonicalizeResult {
  groups: number;
  merged: number;
  skipped: number;
  decisions: CanonicalizeDecision[];
}

const MERGE_MAX_DIST = 0.4; // same gate as believe()'s cross-slug threshold

/**
 * One-time sweep (spec §C1): group live belief heads by canonical slug; for each
 * multi-head group whose claims are pairwise similar, supersede every older head
 * with the newest head's claim under the canonical topic, collapsing the group to
 * one live head. Dissimilar groups are left alone (false merges are worse than
 * duplicates). Every decision — merge or skip — is recorded as a
 * `belief.canonicalize` audit event. Safe to re-run: merged groups vanish from
 * the live set, and the superseding writes are external_id-idempotent.
 */
export function canonicalizeBeliefHeads(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { apply?: boolean } = {},
): CanonicalizeResult {
  const raw = recallBelief(db, { limit: 10_000 });
  const heads: BeliefRecord[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const byCanonical = new Map<string, BeliefRecord[]>();
  for (const h of heads) {
    const c = canonicalizeTopic(h.topic);
    const list = byCanonical.get(c) ?? [];
    list.push(h);
    byCanonical.set(c, list);
  }

  const result: CanonicalizeResult = { groups: 0, merged: 0, skipped: 0, decisions: [] };
  for (const [canonical, group] of byCanonical) {
    if (group.length < 2) continue;
    result.groups++;
    // newest first (recallBelief enumerate is ts DESC already, but make it explicit)
    group.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const winner = group[0];
    const allSimilar = group.slice(1).every((h) => {
      const longer = Math.max(winner.claim.length, h.claim.length);
      return longer > 0 && levenshtein(winner.claim, h.claim) / longer < MERGE_MAX_DIST;
    });

    const decision: CanonicalizeDecision = {
      canonical,
      topics: group.map((h) => h.topic),
      decision: allSimilar ? 'merged' : 'skipped-dissimilar',
      ...(allSimilar ? { winnerEventId: winner.eventId } : {}),
    };
    result.decisions.push(decision);

    if (!allSimilar) {
      result.skipped++;
    } else if (opts.apply) {
      for (const loser of group.slice(1)) {
        believe(db, llm, {
          topic: canonical,
          claim: winner.claim,
          confidence: winner.confidence ?? undefined,
          provenance: winner.provenance,
          verifiedAt: winner.verifiedAt ?? undefined,
          supersedes: loser.eventId,
        });
      }
      result.merged++;
    } else {
      result.merged++; // dry-run counts what WOULD merge
    }

    if (opts.apply) {
      // Audit event per decision (spec: log every merge decision).
      ingest(db, llm, {
        kind: 'belief.canonicalize',
        source: 'maintenance',
        content: `${decision.decision}: [${decision.topics.join(', ')}] → ${canonical}`,
        payload: { ...decision, external_id: `canonicalize:${canonical}:${winner.eventId}` },
      });
    }
  }
  return result;
}
```

NOTE for the implementer: `believe()` with explicit `supersedes` validates topic match by canonical form (Task 2) — superseding a loser whose topic canonicalizes to `canonical` passes by construction. Verify the `recallBelief` enumerate limit default (50) is overridden — pass `limit: 10_000` as shown or the sweep misses heads.

- [ ] **Step 3: CLI wiring.** In `system/surfaces/cli/beliefs.ts`, add a `canonicalize` subcommand following the file's existing subcommand pattern: dry-run by default printing the decision table (`canonical ← [topics] (merged|skipped-dissimilar)` one per line + totals), `--apply` to execute. Open the DB the way the file already does. Register in the `beliefs` case routing and add to the help text in `cli/index.ts` (the `beliefs review` line: `beliefs canonicalize [--apply]   Collapse duplicate belief heads onto canonical topics (dry-run default)`).

- [ ] **Step 4: Run** — `pnpm exec tsx --test system/brain/memory/canonicalize-heads.test.ts system/surfaces/cli/beliefs.test.ts` (if the latter exists) → PASS. `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/canonicalize-heads.ts system/brain/memory/canonicalize-heads.test.ts \
        system/surfaces/cli/beliefs.ts system/surfaces/cli/index.ts
git commit -m "feat(beliefs): one-time canonical merge pass + robin beliefs canonicalize"
```

---

### Task 5: Risk-weighted freshness re-query (C2)

**Files:**
- Modify: `system/brain/cognition/belief-freshness.ts`
- Test: `system/brain/cognition/belief-freshness.test.ts` (extend)

Today's selection is a first-N lottery: heads are processed in enumerate order and the first `maxRequeries` stale heads with resolvers win (belief-freshness.ts:116). C2: collect ALL stale heads first, score them, re-query the top-N by score. Same `maxRequeries` cap — same spend, better targets (spec §C2).

- [ ] **Step 1: Write the failing tests** (the file's existing tests register fake resolvers and seed heads — follow that pattern):

```typescript
test('re-queries the highest-risk stale heads, not the first N', () => {
  // Register one resolver for prefix ''. maxRequeries: 1.
  // Seed two stale heads: A (confidence 0.9, just past TTL, no corrections),
  // B (confidence 0.2, 5× TTL old, 2 corrections rows with topic=B's topic).
  // Enumerate order returns A first (newer ts). Run the pass.
  // assert: resolver was called for B, NOT A; A got flagged.
});

test('correction history on the topic raises the score', () => {
  // Two otherwise-identical stale heads; one has 3 corrections rows on its topic → it wins the single requery slot.
});

test('scoring never throws on null confidence / missing corrections topic', () => {});

test('heads without resolvers are flagged regardless of score (unchanged behavior)', () => {});
```

Seed corrections via `INSERT INTO corrections (what, correction, topic) VALUES (?,?,?)` (topic column from migration 014).

- [ ] **Step 2: Run to verify fail**, then implement. Restructure `runBeliefFreshness`'s loop into two phases:

```typescript
import { ageDaysFrom, FRESHNESS_TTL_DAYS, isStale } from '../memory/provenance.ts';

/** Risk score for a stale head (spec §C2): each component is 0..1 —
 *  uncertainty (1 - confidence), normalized over-age (age vs 4× class TTL,
 *  finite-TTL classes only), and correction pressure on the topic (capped at 3).
 *  Deterministic; no tunables in config. */
function riskScore(db: RobinDb, head: BeliefRecord, ageDays: number): number {
  const uncertainty = 1 - (head.confidence ?? 0.5);
  const ttl = FRESHNESS_TTL_DAYS[head.provenance];
  const overAge = Number.isFinite(ttl) ? Math.min(ageDays / (4 * ttl), 1) : 0;
  const corrections = (
    db.prepare(`SELECT COUNT(*) AS n FROM corrections WHERE topic = ?`).get(head.topic) as { n: number }
  ).n;
  return uncertainty + overAge + Math.min(corrections, 3) / 3;
}
```

Phase 1 (collect): iterate heads exactly as today, but instead of resolving inline, push `{ head, age }` for stale heads into a `staleHeads` array (still per-head try/catch; `result.scanned`/`result.stale` accounting unchanged).

Phase 2 (act): score every stale head once, partition into resolver-bearing and resolver-less, sort the resolver-bearing by score descending, and run the EXISTING resolver/flag logic over them in that order (resolver branch bounded by `maxRequeries` exactly as today; everything that doesn't get re-queried falls to the existing idempotent `belief.stale` flag).

The per-head bodies (resolver call, `believe()` re-confirmation, flag write) move verbatim — only the iteration order and the resolver-slot allocation change.

- [ ] **Step 3: Run the whole freshness test file (existing tests must pass unchanged); commit:**

```bash
git add system/brain/cognition/belief-freshness.ts system/brain/cognition/belief-freshness.test.ts
git commit -m "feat(beliefs): risk-weighted freshness re-query (confidence + age + correction history)"
```

---

### Task 6: Migration 026 — `claim_failures` dead-letter table

**Files:**
- Create: `system/brain/memory/migrations/026-claim-failures.ts`
- Modify: `system/brain/memory/migrations/index.ts`

Slot 026 is the next free number as of plan-writing (025 = agent-outcomes). **The autonomous loop also lands migrations — re-check the directory and renumber if taken (027 in Task 9 shifts too).**

- [ ] **Step 1: Write the migration** (one `db.exec` per statement, per repo convention):

```typescript
// system/brain/memory/migrations/026-claim-failures.ts
import type { Migration } from './types.ts';

/**
 * Phase C (§C3): dead-letter queue for biographer claim extraction. A chunk
 * whose claim pass timed out or failed validation lands here VERBATIM
 * (chunk_body) so retries never depend on the chunker reproducing identical
 * boundaries across code changes. attempts counts extraction tries (initial
 * failure = 1); rows with attempts >= 3 are exhausted audit records, pruned
 * after 30 days by the retry pass.
 */
export const migration026: Migration = {
  version: 26,
  name: 'claim-failures',
  up: (db) => {
    db.exec(`CREATE TABLE claim_failures (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   INTEGER NOT NULL,
      chunk_idx  INTEGER NOT NULL,
      chunk_body TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      ts         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, chunk_idx)
    );`);
    db.exec(`CREATE INDEX claim_failures_attempts ON claim_failures(attempts, ts);`);
  },
};
```

- [ ] **Step 2: Register in `index.ts`; run** `pnpm exec tsx --test system/brain/memory/migrations/runner.test.ts system/brain/memory/migrations/index.test.ts` → PASS (extend the index test's table list only if it asserts table presence globally — check first).

- [ ] **Step 3: Commit**

```bash
git add system/brain/memory/migrations/026-claim-failures.ts system/brain/memory/migrations/index.ts
git commit -m "feat(biographer): claim_failures dead-letter table (migration 026)"
```

---

### Task 7: Biographer writes dead letters on claim failure

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (`extractClaims` + the per-chunk claims loop at ~1453–1494)
- Test: `system/brain/cognition/biographer.test.ts` (extend — find the existing extractClaims/claims-loop tests and follow their fixture style)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('extractClaims reports parse failure distinctly from zero claims', async () => {
  // fake llm.invoke returning non-JSON garbage → { claims: [], failure: 'parse' (or the message) }
  // fake llm.invoke returning {"claims":[]} → { claims: [], failure: undefined }
});

test('a claims-chunk timeout writes a claim_failures row with the verbatim chunk', async () => {
  // fake llm whose invoke never resolves within timeout (or throws TimeoutError) →
  // run the claims loop over a seeded session event; assert claim_failures has
  // (event_id, chunk_idx, chunk_body = the exact chunk text, attempts 1, last_error mentioning timeout)
});

test('a validation failure writes a dead letter; a legitimately empty chunk does not', async () => {});

test('re-failing the same (event_id, chunk_idx) bumps attempts instead of duplicating', async () => {});
```

- [ ] **Step 2: Run to verify fail**, then implement:

(a) `extractClaims` return type (decision 5):

```typescript
export interface ExtractClaimsOutcome {
  claims: ClaimsResult['claims'];
  /** Set when the model responded but its output failed parse/schema validation
   *  ("no durable claims" is NOT a failure — that returns claims: [] with no failure). */
  failure?: string;
}

export async function extractClaims(...): Promise<ExtractClaimsOutcome> {
  // ... existing invoke + fence-strip ...
  let parsed: ReturnType<typeof claimsSchema.safeParse>;
  try {
    parsed = claimsSchema.safeParse(JSON.parse(jsonText));
  } catch (err) {
    return { claims: [], failure: `json parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed.success) return { claims: [], failure: `schema: ${parsed.error.message.slice(0, 200)}` };
  return { claims: parsed.data.claims };
}
```

Update ALL call sites (grep — the per-chunk loop plus any tests).

(b) Dead-letter writer (module-level helper in biographer.ts):

```typescript
/** Upsert a claim-extraction dead letter (spec §C3). attempts counts tries:
 *  first failure inserts 1; a retry that fails again bumps it. Verbatim
 *  chunk_body so the retry never depends on chunker reproducibility. */
function recordClaimFailure(
  db: RobinDb,
  eventId: number,
  chunkIdx: number,
  chunkBody: string,
  error: string,
): void {
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, last_error)
     VALUES (?,?,?,?)
     ON CONFLICT(event_id, chunk_idx) DO UPDATE SET
       attempts = attempts + 1, last_error = excluded.last_error, ts = datetime('now')`,
  ).run(eventId, chunkIdx, chunkBody, error.slice(0, 500));
}
```

(c) In the per-chunk claims loop: the success path destructures `{ claims, failure }`; when `failure` is set, call `recordClaimFailure(db, target.eventId, ci, chunk, failure)` (and still push the existing `result.errors` line). The catch block (timeouts and other throws) also calls `recordClaimFailure` with the error message before pushing to `result.errors`. Both writes wrapped so a dead-letter write failure can't break the loop (`try { recordClaimFailure(...) } catch { /* best-effort */ }`).

- [ ] **Step 3: Run** the biographer test file (all existing tests must pass — the return-type change is the risky part); `pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add system/brain/cognition/biographer.ts system/brain/cognition/biographer.test.ts
git commit -m "feat(biographer): claim-extraction failures land in the dead-letter queue"
```

---

### Task 8: Dead-letter retry pass + backlog alert

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (retry pass, called at the end of the biographer tick)
- Test: `system/brain/cognition/biographer.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('retry pass re-extracts a dead letter and clears it on success', async () => {
  // seed claim_failures row (attempts 1); fake llm now returns valid claims →
  // retryClaimFailures: candidates inserted via the normal dedup path, row DELETED.
});
test('a failed retry bumps attempts; attempts >= 3 rows are not retried', async () => {});
test('retry respects the per-pass cap', async () => {
  // seed 10 open rows, cap 5 → exactly 5 llm calls
});
test('backlog > 10 open rows fires the Phase-A alert; dropping to <= 10 resolves it', async () => {
  // seed 11 open rows + failing llm → alert (source 'biographer', key 'claim-failures-backlog') open;
  // delete 5 rows, rerun → alert resolved_at set.
});
test('exhausted rows older than 30 days are pruned', async () => {});
```

- [ ] **Step 2: Run to verify fail**, then implement:

```typescript
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';

const CLAIM_RETRY_MAX_ATTEMPTS = 3;
const CLAIM_RETRY_PER_PASS = 5;
const CLAIM_BACKLOG_ALERT_THRESHOLD = 10;

export interface ClaimRetryResult {
  retried: number;
  recovered: number;
  openBacklog: number;
}

/**
 * Drain the claim dead-letter queue (spec §C3): retry up to CLAIM_RETRY_PER_PASS
 * open rows (attempts < 3), oldest first, against the same extraction prompt.
 * Success → claims enter the normal candidate pipeline and the row is deleted.
 * Failure → attempts bumps (recordClaimFailure upsert). Exhausted rows are kept
 * 30 days as audit, then pruned here. A backlog of > 10 open rows opens a
 * Phase-A alert; the alert resolves when the backlog drains — event-driven
 * alerts must carry their own resolution path.
 */
export async function retryClaimFailures(
  db: RobinDb,
  llm: LLMDispatcher,
  opts?: { chunkTimeoutMs?: number; max?: number },
): Promise<ClaimRetryResult> {
  const max = opts?.max ?? CLAIM_RETRY_PER_PASS;
  const timeoutMs = opts?.chunkTimeoutMs ?? 120_000;
  const rows = db
    .prepare(
      `SELECT id, event_id, chunk_idx, chunk_body FROM claim_failures
        WHERE attempts < ? ORDER BY ts ASC LIMIT ?`,
    )
    .all(CLAIM_RETRY_MAX_ATTEMPTS, max) as Array<{
    id: number; event_id: number; chunk_idx: number; chunk_body: string;
  }>;

  const result: ClaimRetryResult = { retried: 0, recovered: 0, openBacklog: 0 };
  for (const row of rows) {
    result.retried++;
    try {
      const { claims, failure } = await extractClaims(
        llm, row.chunk_body, timeoutMs, `claim-retry event=${row.event_id} chunk=${row.chunk_idx}`,
      );
      if (failure) {
        recordClaimFailure(db, row.event_id, row.chunk_idx, row.chunk_body, failure);
        continue;
      }
      for (const c of claims) {
        if (!c.topic?.trim() || !c.claim?.trim()) continue;
        await insertCandidateWithDedup(db, llm, {
          topic: c.topic, claim: c.claim, confidence: c.confidence ?? null,
          sourceEventId: row.event_id, provenance: 'unknown',
        });
      }
      db.prepare(`DELETE FROM claim_failures WHERE id = ?`).run(row.id);
      result.recovered++;
    } catch (err) {
      recordClaimFailure(db, row.event_id, row.chunk_idx, row.chunk_body,
        err instanceof Error ? err.message : String(err));
    }
  }

  // Prune exhausted audit rows past retention.
  db.prepare(
    `DELETE FROM claim_failures WHERE attempts >= ? AND datetime(ts) < datetime('now','-30 days')`,
  ).run(CLAIM_RETRY_MAX_ATTEMPTS);

  // Backlog alert with resolution path.
  result.openBacklog = (
    db.prepare(`SELECT COUNT(*) AS n FROM claim_failures WHERE attempts < ?`)
      .get(CLAIM_RETRY_MAX_ATTEMPTS) as { n: number }
  ).n;
  try {
    if (result.openBacklog > CLAIM_BACKLOG_ALERT_THRESHOLD) {
      recordAlert(db, {
        severity: 'warning', source: 'biographer', key: 'claim-failures-backlog',
        message: `${result.openBacklog} claim-extraction chunks failing (dead-letter backlog)`,
      });
    } else {
      resolveAlert(db, 'biographer', 'claim-failures-backlog');
    }
  } catch { /* alerting never breaks the pass */ }

  return result;
}
```

NOTE on provenance: the original chunk's provenance was derived from the source event kind at extraction time (biographer.ts:1446) — recompute it the same way inside the retry (look up the event's kind via `SELECT kind FROM events WHERE id = ?` and reuse `classifyProvenance`) rather than hardcoding 'unknown'; the snippet above simplifies, the implementation should match the original path.

Wire the call: at the end of the biographer tick run function (where the per-tick work completes — after the chunk budget is spent), call `await retryClaimFailures(db, llm)` guarded by `llm` being available, inside try/catch, and surface its counts in the tick result message/log the way other sub-pass counts are surfaced.

- [ ] **Step 3: Run** biographer tests; `pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add system/brain/cognition/biographer.ts system/brain/cognition/biographer.test.ts
git commit -m "feat(biographer): bounded dead-letter retry with backlog alert + retention"
```

---

### Task 9: Migration 027 — `profile_generated_at` + write-time stamping

**Files:**
- Create: `system/brain/memory/migrations/027-profile-generated-at.ts`
- Modify: `system/brain/memory/migrations/index.ts`
- Modify: `system/brain/memory/entity.ts` (`EntityRow` + `upsertEntity` profile write, entity.ts:68–71)
- Modify: `system/brain/cognition/dream.ts` (`summarizeHotEntities` profile write + stale-fill selection)
- Tests: `system/brain/memory/entity.test.ts`, `system/brain/cognition/dream.test.ts` (extend)

- [ ] **Step 1: Migration** (backfill = migration date, spec §C4: "accurate in practice, since profiles were re-synthesized 2026-06-10"):

```typescript
// system/brain/memory/migrations/027-profile-generated-at.ts
import type { Migration } from './types.ts';

/**
 * Phase C (§C4): track when an entity profile was synthesized so read surfaces
 * can refuse to serve stale text as current truth. Backfill: profiled rows get
 * the migration date (profiles were re-synthesized 2026-06-10, so this is
 * accurate in practice); unprofiled rows stay NULL.
 */
export const migration027: Migration = {
  version: 27,
  name: 'profile-generated-at',
  up: (db) => {
    db.exec(`ALTER TABLE entities ADD COLUMN profile_generated_at TEXT;`);
    db.exec(`UPDATE entities SET profile_generated_at = datetime('now') WHERE profile IS NOT NULL;`);
  },
};
```

Register; run the migration test files.

- [ ] **Step 2: Stamp every profile write.** Two writers touch `entities.profile`:
  - `upsertEntity` (entity.ts:68–71): extend the UPDATE and the INSERT to set `profile_generated_at = datetime('now')` whenever a non-null profile is written.
  - `summarizeHotEntities` (dream.ts:526–529): same one-column addition to its UPDATE.
  Add `profile_generated_at: string | null` to `EntityRow`. Tests: upsert with profile → column set; upsert without profile → stays NULL.

- [ ] **Step 3: Stale-profile regeneration fill (dream).** In `summarizeHotEntities`, after the hot query returns fewer than `ENTITY_SUMMARY_MAX_PER_RUN` rows, fill the remaining slots with stale-profile entities that have recent activity (spec: "the dream pass regenerates stale profiles for hot entities under its existing budget"):

```typescript
  const remaining = ENTITY_SUMMARY_MAX_PER_RUN - hot.length;
  if (remaining > 0) {
    const staleHot = db
      .prepare(`
        SELECT e.id, e.type, e.canonical_name, COUNT(*) AS signals
          FROM entities e
          JOIN relations r ON r.subject_id = e.id OR r.object_id = e.id
         WHERE e.profile IS NOT NULL
           AND datetime(e.profile_generated_at) < datetime('now','-30 days')
           AND datetime(r.ts) >= datetime('now','-7 days')
           AND e.id NOT IN (${hot.map(() => '?').join(',') || 'NULL'})
         GROUP BY e.id
         ORDER BY signals DESC
         LIMIT ?
      `)
      .all(...hot.map((h) => h.id), remaining) as typeof hot;
    hot.push(...staleHot);
  }
```

(Adapt the empty-`hot` IN-clause edge; the existing per-entity summarize loop then handles them unchanged — and Step 2's stamping refreshes `profile_generated_at`.) Test: seed an entity with a 40-day-old profile + recent relations and no ≥3-signal hot entities → it gets re-summarized.

- [ ] **Step 4: Run** entity + dream test files; commit:

```bash
git add system/brain/memory/migrations/027-profile-generated-at.ts system/brain/memory/migrations/index.ts \
        system/brain/memory/entity.ts system/brain/memory/entity.test.ts \
        system/brain/cognition/dream.ts system/brain/cognition/dream.test.ts
git commit -m "feat(entities): profile_generated_at — stamped writes + stale-profile regeneration fill"
```

---

### Task 10: Stale-profile gate at the entity read boundary

**Files:**
- Modify: `system/brain/memory/entity.ts` (new `withFreshProfile` helper + relation summary)
- Modify: `system/surfaces/mcp/core/server.ts` (`find_entity`, `get`) and `system/surfaces/mcp/extension/server.ts` (`related_entities`) — wrap returned entities
- Test: `system/brain/memory/entity.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('withFreshProfile passes fresh profiles through untouched', () => {});
test('withFreshProfile replaces a >30-day profile with a deterministic relation summary', () => {
  // entity with profile_generated_at 40d ago + 3 relations → profile becomes
  // 'recent relations: <name> <predicate> <other>; ...' and profile_stale: true
});
test('withFreshProfile on a stale profile with no relations nulls the profile', () => {});
test('NULL profile_generated_at with a non-null profile is treated as stale (pre-migration writers)', () => {});
```

- [ ] **Step 2: Implement in entity.ts:**

```typescript
const PROFILE_STALE_DAYS = 30;

/** Deterministic relation summary — the no-LLM fallback for stale profiles. */
function relationSummary(db: RobinDb, entityId: number, name: string): string | null {
  const rows = db
    .prepare(`
      SELECT r.predicate,
             CASE WHEN r.subject_id = ? THEN obj.canonical_name ELSE sub.canonical_name END AS other,
             CASE WHEN r.subject_id = ? THEN 'subject' ELSE 'object' END AS role
        FROM relations r
        JOIN entities sub ON sub.id = r.subject_id
        JOIN entities obj ON obj.id = r.object_id
       WHERE r.subject_id = ? OR r.object_id = ?
       ORDER BY r.ts DESC LIMIT 5
    `)
    .all(entityId, entityId, entityId, entityId) as Array<{ predicate: string; other: string; role: string }>;
  if (rows.length === 0) return null;
  const lines = rows.map((o) =>
    o.role === 'subject' ? `${name} ${o.predicate} ${o.other}` : `${o.other} ${o.predicate} ${name}`,
  );
  return `recent relations: ${lines.join('; ')}`;
}

/**
 * Read-side staleness gate (spec §C4): a profile older than 30 days must not be
 * served as current truth. Stale (or unstamped) profiles are swapped for a
 * deterministic relation summary and marked profile_stale so consumers know the
 * synthesized text was withheld. Fresh profiles pass through untouched.
 */
export function withFreshProfile(
  db: RobinDb,
  row: EntityRow,
  now: () => Date = () => new Date(),
): EntityRow & { profile_stale?: boolean } {
  if (!row.profile) return row;
  const cutoff = new Date(now().getTime() - PROFILE_STALE_DAYS * 86_400_000).toISOString();
  const fresh =
    row.profile_generated_at !== null &&
    (db.prepare(`SELECT datetime(?) >= datetime(?) AS ok`).get(row.profile_generated_at, cutoff) as { ok: number }).ok === 1;
  if (fresh) return row;
  return { ...row, profile: relationSummary(db, row.id, row.canonical_name), profile_stale: true };
}
```

(The `datetime()` round-trip handles sqlite-format `profile_generated_at` vs ISO cutoff — decision 8. A plain in-process compare is fine IF both are normalized; implementer may use `Date.parse` with the `+'Z'` suffix idiom from `cli/alerts.ts` instead — pick one and test it.)

- [ ] **Step 3: Apply at the read surfaces.** In `system/surfaces/mcp/core/server.ts`: `find_entity` maps hits through `withFreshProfile(deps.db, h)`; `get` wraps `getEntity`/`upsertEntity` results (only when an entity row is returned). In `system/surfaces/mcp/extension/server.ts`: `related_entities` maps its rows the same way. Keep the wrapping at the tool layer — internal callers (merge/hygiene) still see raw rows.

- [ ] **Step 4: Run** entity tests + `pnpm typecheck` + both server test files if present. Commit:

```bash
git add system/brain/memory/entity.ts system/brain/memory/entity.test.ts \
        system/surfaces/mcp/core/server.ts system/surfaces/mcp/extension/server.ts
git commit -m "feat(entities): stale profiles served as relation summaries, never as current truth"
```

---

### Task 11: Finalize — gates, build, daemon restart, live verification

- [ ] **Step 1: Full gates.** `pnpm lint && pnpm typecheck && pnpm test` — clean except the 4 known pre-existing failures (spotify ×2, ebird, recall); zero NEW failures.
- [ ] **Step 2: Build + restart.** `pnpm build && launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon` (daemon applies migrations 026/027 on boot; verify via `sqlite3 user-data/state/db/robin.sqlite "PRAGMA table_info(claim_failures); PRAGMA table_info(entities);"`).
- [ ] **Step 3: One-time canonical sweep (the C1 payoff).**
  - `node dist/surfaces/cli/index.js beliefs canonicalize` → READ the dry-run decision table. Sanity-check a few groups by hand (`robin beliefs review` / `recall_belief`) — especially any `skipped-dissimilar` groups.
  - If the table looks right: `node dist/surfaces/cli/index.js beliefs canonicalize --apply`.
  - Verify: re-run dry-run → 0 mergeable groups; `recall_belief` on a known pre-merge topic string (e.g. a negated variant from the dry-run table) resolves the canonical head.
- [ ] **Step 4: Live spot-checks.**
  - `node dist/surfaces/cli/index.js alerts` → no unexpected `biographer` alerts (claim backlog starts empty).
  - `sqlite3 ... "SELECT COUNT(*) FROM claim_failures"` → 0 (or small, after the next biographer tick).
  - `sqlite3 ... "SELECT COUNT(*) FROM entities WHERE profile IS NOT NULL AND profile_generated_at IS NULL"` → 0 (backfill complete).
  - Next nightly dream + freshness pass: check the daemon log (or journal) for the freshness pass running with scored selection (no errors).
- [ ] **Step 5: Update `docs/STATUS.md`** (Recent changes — Phase C section, same style as Phase A/B entries). Commit stragglers with explicit paths only.

---

## Self-review notes (already applied)

- Spec §C1 → Tasks 1–4 (canonicalizer in the believe() choke point, both-slug-AND-similarity gate, lookup symmetry without an alias table, one-time merge pass with the same normalizer, audit-event logging). §C2 → Task 5 (risk score = confidence + age + correction history; same maxRequeries spend). §C3 → Tasks 6–8 (verbatim chunk_body dead letters, max 3 attempts inside the biographer budget, >10-open Phase-A alert with resolution path). §C4 → Tasks 9–10 (profile_generated_at + migration-date backfill, dream regeneration under the existing 25-entity budget, read-side staleness gate with relation-summary fallback).
- Spec deviations are enumerated in the decisions block: audit events instead of journal-body lines (decision 4), the read-side gate living at the entity MCP boundary because auto-recall never serves profiles (decision 7), the 0.4 cross-slug threshold vs 0.2 candidate-merge (decision 2 — negation words inflate distance between same-fact claims).
- Zero new LLM spend: canonicalization, scoring, dead-letter writes, and the staleness gate are all deterministic; the retry pass and stale-profile regeneration run INSIDE existing budgets (biographer chunk budget, dream's 25-entity cap), substituting work rather than adding it. The one-time merge pass writes belief events through `believe()` (no LLM calls — `llm` is only threaded for ingest's embed-later path, same as today).
- Type consistency: `canonicalizeTopic` operates on normalizeTopic output everywhere (believe, recallBelief, merge pass); `ExtractClaimsOutcome` is consumed by both the chunk loop and the retry pass; `EntityRow.profile_generated_at` is read by `withFreshProfile` and written by both profile writers.
- Sequencing inside the plan: Tasks 2–3 make new writes/reads canonical-safe BEFORE the sweep (Task 4) rewrites history; the finalize step runs the sweep immediately after deploy to close the legacy-head window (decision 3).

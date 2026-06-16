# Domain-Gated Memory Ingestion — Implementation Plan (Phase D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop dev/engineering content from entering Robin's long-term memory by inverting the extraction filter from an unbounded *blocklist* to a closed *personal-domain allowlist*, tagged per claim/entity at extraction and enforced again at the belief-promotion gate.

**Architecture:** A new `domains.ts` defines the closed `PERSONAL_DOMAINS` set. The biographer's two extraction prompts (entities, claims) are rewritten to emit a `domain` tag per item and to extract only personal-life facts; items not in a personal domain are dropped at extraction. A `domain` column on `belief_candidates` carries the tag to the promotion gate, where an explicit engineering-artifact domain is rejected (NULL grandfathered as promotable). A `biographer.domainGating` policy flag is the runtime kill-switch (mirrors `draftClaims`). The existing deterministic backstops (`isLowQualityEntity`, `isLowQualityClaim`) stay as the hard floor.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 via `RobinDb`, `zod` schemas, `node:test` + `node:assert/strict` collocated tests.

**Spec:** `docs/design/2026-06-16-domain-gated-memory-design.md`. Builds on shipped Phase C (`2026-06-10-trust-feedback-memory-design.md`).

**Conventions for every task:** run a single test file with `pnpm exec tsx --test <file>`; full gates at the end are `pnpm lint && pnpm typecheck && pnpm test` (4 pre-existing failures are known and not ours: spotify ×2, ebird, recall). Commit after each task; author email `kevin.kik.lee@gmail.com`. The pre-commit hook auto-formats — **never `git add -A`** (the autonomous daemon edits this tree concurrently); always stage explicit paths.

**Decisions baked into this plan** (read before implementing; each is deliberate):

1. **Drop at extraction is strict; the promotion gate grandfathers.** A NEW claim/entity must carry a valid personal `domain` or it is dropped at extraction (the allowlist). But the promotion gate (Task 4) only blocks a candidate whose `domain` is *explicitly* non-personal — a NULL domain (every pre-Phase-D candidate) stays promotable. Otherwise the migration would freeze promotion of the entire existing pending queue.
2. **The `domain` schema field is a permissive string, not a zod enum.** A strict `z.enum` would fail the WHOLE chunk parse if the model emits one unknown domain — dead-lettering good claims. Instead the field is `z.string().nullable().optional()` and `isPersonalDomain()` filters in code. One bad tag drops one item, never the chunk.
3. **Recall bias (Q3-B) lives in the PROMPT, not in keeping untagged items.** The prompt explicitly tells the model to KEEP and tag a personal fact even when it appears in passing during technical work. An item the model leaves untagged is treated as "not a personal fact" and dropped — keeping untagged items would reopen the dev leak.
4. **Kill-switch is a policy flag, not env.** `biographer.domainGating` resolves from `policies.yaml` at handler time via a `getDomainGating()` resolver passed into `registerCognitionJobs`, exactly like `getDraftClaims` — so a regression is disabled by editing `policies.yaml`, no daemon restart (the daemon serves stale in-memory code on a code revert).
5. **Deterministic backstops stay.** `isLowQualityEntity` / `isLowQualityClaim` are NOT removed — they are the hard floor for the zero-tolerance junk end (SHAs, commits, `io.robin-assistant.*`, Robin internals) that must never depend on LLM judgment. The allowlist is added in FRONT of them, not in place of them.
6. **Component 2 (pure-dev session skip) is the one optional task (Task 9).** Code review found the self-capture half of the design's Component 2 is already shipped (capture scanner skips user-data dirs + baselines idle files; `isLowQualityClaim` enforced at draft+promote). The remaining piece is a spend optimization that skips extraction on confidently pure-dev sessions — valuable but carrying false-negative recall risk, so it is isolated and skippable.

---

### Task 1: `PERSONAL_DOMAINS` + `isPersonalDomain()` — shared domain module

**Files:**
- Create: `system/brain/memory/domains.ts`
- Test: `system/brain/memory/domains.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// system/brain/memory/domains.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAL_DOMAINS, isPersonalDomain } from './domains.ts';

test('PERSONAL_DOMAINS is the closed 11-domain set', () => {
  assert.equal(PERSONAL_DOMAINS.length, 11);
  assert.ok(PERSONAL_DOMAINS.includes('health'));
  assert.ok(PERSONAL_DOMAINS.includes('directives'));
});

test('isPersonalDomain accepts members, rejects everything else', () => {
  assert.equal(isPersonalDomain('finance'), true);
  assert.equal(isPersonalDomain('directives'), true);
  assert.equal(isPersonalDomain('engineering'), false);
  assert.equal(isPersonalDomain('library'), false);
  assert.equal(isPersonalDomain(''), false);
  assert.equal(isPersonalDomain(null), false);
  assert.equal(isPersonalDomain(undefined), false);
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/brain/memory/domains.test.ts` → FAIL ("Cannot find module './domains.ts'").

- [ ] **Step 3: Implement**

```typescript
// system/brain/memory/domains.ts
/**
 * The closed set of personal-life domains Robin's memory is allowed to hold
 * (Phase D, domain-gated ingestion). The biographer extracts ONLY facts/entities
 * in one of these domains; anything outside is engineering/transient noise and is
 * dropped. Inverting the old unbounded dev BLOCKLIST into this finite ALLOWLIST is
 * the whole point: a novel dev concept is excluded by absence, never by a new rule.
 *
 * `directives` is the one door adjacent to dev noise — it holds STANDING rules
 * Kevin sets for how he works / how Robin behaves (durable workflow + tooling
 * preferences). The biographer prompt gates it with the durable-rule-vs-transient-
 * task test; this module only checks set membership.
 */
export const PERSONAL_DOMAINS = [
  'health',
  'finance',
  'career',
  'relationships',
  'preferences',
  'creative',
  'travel',
  'home',
  'life_events',
  'identity',
  'directives',
] as const;

export type PersonalDomain = (typeof PERSONAL_DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(PERSONAL_DOMAINS);

/** True only for an exact member of the closed personal-domain set. */
export function isPersonalDomain(value: string | null | undefined): value is PersonalDomain {
  return typeof value === 'string' && DOMAIN_SET.has(value);
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/brain/memory/domains.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/domains.ts system/brain/memory/domains.test.ts
git commit -m "feat(memory): closed PERSONAL_DOMAINS allowlist + isPersonalDomain"
```

---

### Task 2: Migration — `domain` column on `belief_candidates` and `entities`

**Files:**
- Create: `system/brain/memory/migrations/028-memory-domain.ts`
- Modify: `system/brain/memory/migrations/index.ts`

**Slot number:** 028 was the next free slot at plan-writing (027 = profile-generated-at). **Re-check `system/brain/memory/migrations/` and renumber if the autonomous daemon landed a newer migration.**

- [ ] **Step 1: Write the migration** (one `db.exec` per statement, per repo convention — pattern from `013-belief-candidate-provenance.ts`):

```typescript
// system/brain/memory/migrations/028-memory-domain.ts
import type { Migration } from './types.ts';

/**
 * Phase D: personal-domain tag for memory items. The biographer tags each
 * belief candidate and entity with a PERSONAL_DOMAINS value at extraction; the
 * promotion gate rejects an explicit non-personal domain. Nullable for back-compat
 * — pre-Phase-D rows stay NULL and are grandfathered as promotable.
 */
export const migration028: Migration = {
  version: 28,
  name: 'memory-domain',
  up: (db) => {
    db.exec(`ALTER TABLE belief_candidates ADD COLUMN domain TEXT;`);
    db.exec(`ALTER TABLE entities ADD COLUMN domain TEXT;`);
  },
};
```

- [ ] **Step 2: Register in `index.ts`.** Open `system/brain/memory/migrations/index.ts`, import `migration028`, and append it to the ordered migrations array (follow the existing import + array-entry pattern exactly).

- [ ] **Step 3: Run** — `pnpm exec tsx --test system/brain/memory/migrations/runner.test.ts system/brain/memory/migrations/index.test.ts` → PASS. (If `index.test.ts` asserts a specific migration count, bump it.)

- [ ] **Step 4: Verify columns**

```bash
pnpm exec tsx -e "import('./system/brain/memory/db.ts').then(async m => { const db = m.openInMemory ? m.openInMemory() : null; })" 2>/dev/null || true
```

(If no in-memory helper, the migration runner test already proves the ALTERs apply; skip the ad-hoc check.)

- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/migrations/028-memory-domain.ts system/brain/memory/migrations/index.ts
git commit -m "feat(memory): domain column on belief_candidates + entities (migration 028)"
```

---

### Task 3: Thread `domain` through candidate insertion

**Files:**
- Modify: `system/brain/memory/belief-candidate.ts` (`insertBeliefCandidate` ~118–156, `insertCandidateWithDedup` ~175–end of its insert path)
- Test: `system/brain/memory/belief-candidate.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (follow the file's existing in-memory-DB fixture style):

```typescript
test('insertBeliefCandidate persists the domain tag', () => {
  const r = insertBeliefCandidate(db, {
    topic: 'home-location', claim: 'Kevin lives in Astoria', domain: 'home',
  });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as { domain: string | null };
  assert.equal(row.domain, 'home');
});

test('insertBeliefCandidate defaults domain to NULL when omitted', () => {
  const r = insertBeliefCandidate(db, { topic: 'coffee', claim: 'Kevin drinks espresso' });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as { domain: string | null };
  assert.equal(row.domain, null);
});

test('insertCandidateWithDedup (no embedder) persists the domain via the exact-match fallback', async () => {
  const r = await insertCandidateWithDedup(db, null, {
    topic: 'primary-camera', claim: 'Kevin shoots a Nikon Zf', domain: 'creative',
  });
  const row = db.prepare(`SELECT domain FROM belief_candidates WHERE id = ?`).get(r.id) as { domain: string | null };
  assert.equal(row.domain, 'creative');
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/brain/memory/belief-candidate.test.ts` → FAIL (domain not persisted / not in input type).

- [ ] **Step 3: Implement.** In `insertBeliefCandidate`, add `domain` to the input type and the INSERT:

```typescript
export function insertBeliefCandidate(
  db: RobinDb,
  input: {
    topic: string;
    claim: string;
    confidence?: number | null;
    sourceEventId?: number | null;
    provenance?: ProvenanceClass | null;
    domain?: string | null;
  },
): { id: number } {
  // ...existing topic/claim validation + isLowQualityClaim guard unchanged...

  // existing exact-dupe SELECT unchanged...

  const info = db
    .prepare(
      `INSERT INTO belief_candidates (topic, claim, confidence, source_event_id, provenance, domain)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      topic,
      claim,
      input.confidence ?? null,
      input.sourceEventId ?? null,
      input.provenance ?? null,
      input.domain ?? null,
    );
  return { id: Number(info.lastInsertRowid) };
}
```

In `insertCandidateWithDedup`, add `domain?: string | null` to its input type. Both fallback calls already forward `input` to `insertBeliefCandidate(db, input)` (lines ~193, ~200) — since `input` now carries `domain`, those propagate automatically. If the merge-path (dedup hit) does NOT call `insertBeliefCandidate`, no domain write is needed there (a merge bumps corroboration on the existing canonical row and keeps that row's domain).

- [ ] **Step 4: Run to verify pass** — same command → PASS. Run the whole file so existing dedup/merge tests stay green.

- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/belief-candidate.ts system/brain/memory/belief-candidate.test.ts
git commit -m "feat(memory): thread personal-domain tag through candidate insertion"
```

---

### Task 4: Domain gate in `resolveBeliefCandidate`

**Files:**
- Modify: `system/brain/memory/belief-candidate.ts` (`resolveBeliefCandidate` ~440–521; `RawRow` type to add `domain`)
- Test: `system/brain/memory/belief-candidate.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('a candidate tagged with a non-personal domain never promotes', () => {
  const c = insertBeliefCandidate(db, {
    topic: 'biographer-chunk-size', claim: 'The chunk size is 20k chars',
    domain: 'engineering', confidence: 0.99, provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'reject');
  assert.equal(res.blockedReason, 'engineering-not-durable');
  assert.equal(res.promotedBeliefEventId, null);
});

test('a NULL-domain candidate is grandfathered — still promotable', () => {
  const c = insertBeliefCandidate(db, {
    topic: 'home-location', claim: 'Kevin lives in Astoria',
    confidence: 0.9, provenance: 'first-party', // domain omitted → NULL
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId);
});

test('a personal-domain candidate promotes normally', () => {
  const c = insertBeliefCandidate(db, {
    topic: 'primary-camera', claim: 'Kevin shoots a Nikon Zf',
    domain: 'creative', confidence: 0.9, provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, c.id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId);
});
```

- [ ] **Step 2: Run to verify fail** → the first test fails (engineering candidate currently promotes).

- [ ] **Step 3: Implement.** Add `domain` to the `RawRow` type (find its declaration in the file; add `domain: string | null`). Insert the domain gate immediately AFTER the `isLowQualityClaim` backstop (after line ~485) and BEFORE the `cls`/external gate (line ~487):

```typescript
  // Domain gate (Phase D): a candidate EXPLICITLY tagged with a non-personal
  // (engineering-artifact) domain never promotes — defense-in-depth for anything
  // that slips past the extraction allowlist. A NULL domain is pre-Phase-D /
  // untagged and is grandfathered as promotable; only an explicit non-personal
  // tag blocks here.
  if (row.domain != null && !isPersonalDomain(row.domain)) {
    db.prepare(
      `UPDATE belief_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(now, id);
    return {
      candidateId: id,
      action: 'reject',
      promotedBeliefEventId: null,
      blockedReason: 'engineering-not-durable',
    };
  }
```

Add the import at the top of `belief-candidate.ts`:

```typescript
import { isPersonalDomain } from './domains.ts';
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/brain/memory/belief-candidate.test.ts` → PASS (whole file, including existing promote/reject/external/threshold tests).

- [ ] **Step 5: Commit**

```bash
git add system/brain/memory/belief-candidate.ts system/brain/memory/belief-candidate.test.ts
git commit -m "feat(memory): promotion-gate rejects explicit non-personal domains (NULL grandfathered)"
```

---

### Task 5: Claims allowlist — schema tag, prompt rewrite, extraction drop

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (`claimsSchema` ~96–106; `CLAIMS_SYSTEM_PROMPT` ~169–183; the claims loop ~1789–1806; the `result` shape for the drop counter)
- Test: `system/brain/cognition/biographer.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** (mock the LLM to return a fixed claims JSON; follow the file's existing `extractClaims`/claims-loop fixture style):

```typescript
test('claimsSchema accepts and preserves a domain tag', () => {
  const parsed = claimsSchema.parse({
    claims: [{ topic: 'home', claim: 'Kevin lives in Astoria', confidence: 0.9, domain: 'home' }],
  });
  assert.equal(parsed.claims[0].domain, 'home');
});

test('claimsSchema tolerates a missing domain (no parse failure)', () => {
  const parsed = claimsSchema.parse({ claims: [{ topic: 'x', claim: 'y' }] });
  assert.equal(parsed.claims[0].domain ?? null, null);
});

test('the claims loop drops claims whose domain is not personal', async () => {
  // Seed a captured session event; mock extractClaims (or llm.invoke) to return:
  //   [{ topic:'flight', claim:'Kevin flies to Tokyo next week', domain:'travel' },
  //    { topic:'fn', claim:'extractClaims returns an outcome', domain:'engineering' },
  //    { topic:'untagged', claim:'something', /* no domain */ }]
  // Run the biographer claims pass over it.
  // Assert: exactly ONE pending belief_candidate (the travel one); the
  // engineering + untagged claims were dropped; result.claimsDropped === 2.
});
```

- [ ] **Step 2: Run to verify fail** → schema lacks `domain`; loop doesn't drop.

- [ ] **Step 3: Implement.**

(a) `claimsSchema` (~96): add the permissive domain field (decision 2):

```typescript
const claimsSchema = z.object({
  claims: z
    .array(
      z.object({
        topic: z.string(),
        claim: z.string(),
        confidence: z.number().nullable().optional(),
        domain: z.string().nullable().optional(),
      }),
    )
    .default([]),
});
```

(b) Replace `CLAIMS_SYSTEM_PROMPT` (~169–183) with the positive allowlist:

```typescript
const CLAIMS_SYSTEM_PROMPT = `You extract DURABLE PERSONAL FACTS about Kevin from a transcript. Reply ONLY with JSON matching:
{"claims":[{"topic":"<short-kebab-topic>","claim":"<one declarative sentence>","confidence":<0..1>,"domain":"<one of the domains below>"}, ...]}

This transcript is LIKELY DOMINATED BY SOFTWARE ENGINEERING — on Robin itself or on Kevin's other projects. Do NOT extract engineering artifacts or state: code, functions, files, configs, bugs, commits, architecture, libraries, tools, build systems, schemas, or Robin's own internals. Those are NOT memory.

Extract ONLY facts that belong to one of these personal domains, and tag each with its "domain":
- health — medical, fitness, sleep, body, conditions, medications
- finance — accounts, investments, taxes, purchases, income
- career — job, role, employer, work history, professional goals
- relationships — family, friends, social ties
- preferences — tastes, opinions, likes/dislikes (food, media, style)
- creative — photography, gear, creative practice and hobby projects
- travel — trips taken or planned, places visited
- home — residence, household, possessions
- life_events — milestones, personal schedule, plans of personal significance
- identity — background, traits, worldview, who Kevin is
- directives — a STANDING rule Kevin sets for how he works or how Robin should behave (durable workflow/tooling preference), e.g. "commit as kevin.kik.lee@gmail.com", "pnpm dev:log is the required dev command". NOT a one-time task about the current code ("refactor X to use zod") and NOT a transient build state.

Rules:
- A claim must still be true in a future session. When a personal fact appears IN PASSING during technical work, KEEP it and tag its domain.
- If a fact does not fit one of the domains above, OMIT it — do not invent a domain.
- topic: a short kebab-case key (e.g. "google-role", "home-location", "primary-camera").
- confidence: your 0..1 confidence that this is a durable, correct fact.
If nothing durable and personal is present, reply {"claims":[]}.`;
```

(c) In the claims loop (~1789), drop non-personal claims and count them. First add `claimsDropped` to the biographer `result` accumulator (find where `claimsDrafted` is initialised on the result object and add `claimsDropped: 0` beside it; add it to the result type/interface too). Then:

```typescript
            for (const c of claims) {
              if (sessionPending >= MAX_CLAIMS_PER_SESSION) break;
              if (!c.topic?.trim() || !c.claim?.trim()) continue;
              // Allowlist gate (Phase D): only personal-domain claims enter the
              // queue. An untagged or non-personal claim is engineering/transient
              // noise — drop it. The deterministic isLowQualityClaim backstop
              // inside insertCandidateWithDedup still runs on what passes.
              if (domainGating && !isPersonalDomain(c.domain)) {
                result.claimsDropped++;
                continue;
              }
              const inserted = await insertCandidateWithDedup(db, llm, {
                topic: c.topic,
                claim: c.claim,
                confidence: c.confidence ?? null,
                sourceEventId: target.eventId,
                provenance: targetProvenance,
                domain: c.domain ?? null,
              });
              if (inserted.id === -1) continue;
              if (inserted.merged) continue;
              sessionPending++;
              result.claimsDrafted++;
            }
```

(d) Add the import at the top of `biographer.ts`:

```typescript
import { isPersonalDomain } from '../memory/domains.ts';
```

(`domainGating` is the kill-switch boolean wired in Task 7. Until then, define a local `const domainGating = options.domainGating ?? true;` near where `draftClaims` is read (~1508) so this task compiles and tests pass with gating ON by default.)

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/brain/cognition/biographer.test.ts` → PASS (whole file). `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/brain/cognition/biographer.ts system/brain/cognition/biographer.test.ts
git commit -m "feat(biographer): personal-domain allowlist for claim extraction"
```

---

### Task 6: Entity allowlist — schema tag, prompt rewrite, extraction drop

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (`extractionSchema` ~67–85; `SYSTEM_PROMPT` ~842–877; `SESSION_SUMMARY_PROMPT` exemplar ~164; entity filter loop ~1866–1874)
- Test: `system/brain/cognition/biographer.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('extractionSchema accepts a domain tag on entities', () => {
  const parsed = extractionSchema.parse({
    entities: [{ type: 'camera', name: 'Nikon Zf', domain: 'creative' }],
    relations: [],
  });
  assert.equal(parsed.entities[0].domain, 'creative');
});

test('the entity filter drops entities whose domain is not personal', () => {
  // Build an ExtractionResult with three entities:
  //   { type:'camera', name:'Nikon Zf', domain:'creative' }  → kept
  //   { type:'tool', name:'biographer.ts', domain:'engineering' } → dropped (domain)
  //   { type:'person', name:'Kevin' /* no domain */ } → dropped (untagged)
  // Run the entity filter stage (extract the loop into a tested helper OR call the
  // run path with a mocked extraction) and assert only 'Nikon Zf' survives, and a
  // relation pointing at a dropped name is also dropped.
});
```

> Implementation note: if the filter loop is currently inline in `runBiographer`, extract it into an exported pure helper `filterByDomainAndQuality(extracted, noiseBlocklist, domainGating)` so it is unit-testable, and call that helper from the run path. Keep the existing `isLowQualityEntity` / `noiseBlocklist` / flood-guard logic inside it unchanged — only ADD the domain check.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.**

(a) `extractionSchema` entities (~70): add `domain`:

```typescript
  entities: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        domain: z.string().nullable().optional(),
      }),
    )
    .default([]),
```

(b) Rewrite `SYSTEM_PROMPT` (~842) to require a domain tag and frame the allowlist. Keep the existing predicate/normalization rules verbatim; change the header, the schema line, and the "Do NOT extract" block:

```typescript
const SYSTEM_PROMPT = `You extract structured PERSONAL entities and relations about Kevin's life from a transcript. Reply ONLY with JSON matching:
{"entities":[{"type":"<type>","name":"...","domain":"<personal domain>"}, ...], "relations":[{"subject":"name","predicate":"verb","object":"name"}, ...]}

${USER_CONTEXT}

This transcript is LIKELY DOMINATED BY SOFTWARE ENGINEERING. Extract ONLY entities that belong to Kevin's personal life, and tag each with a "domain" from: health, finance, career, relationships, preferences, creative, travel, home, life_events, identity, directives. An entity that does not fit one of these domains is engineering/transient noise — OMIT it (do not invent a domain).

Valid <type> values (use the MOST SPECIFIC that fits):
  person, place, restaurant, organization, company, service, product, gear,
  camera, lens, financial_account, medication, event, project, book, film,
  album, artist, song, species, topic, thing.
Use "thing" ONLY when nothing more specific applies, and only if it still fits a personal domain.

Relation rules:
- Use a SPECIFIC, MEANINGFUL predicate — a verb phrase describing a real directed
  relationship (e.g. "lives_in", "works_at", "owns", "photographed_at", "prescribed").
- Subject = the actor/owner; object = the target/thing acted upon. Always maintain
  this direction so "Kevin works_at Google" and "Google employs Kevin" aren't both
  emitted — pick one canonical direction (prefer Kevin as subject for his actions).
- Do NOT use vague co-occurrence predicates: "related_to", "associated_with",
  "mentioned_with", "appears_with", "occurs_with". If no clear directed
  relationship exists, omit the relation entirely.
- NORMALIZE predicates to a canonical form: use "works_at" not "employed_by",
  "lives_in" not "resides_at", "owns" not "possesses", "uses" not "utilizes".

Do NOT extract: transcript role markers; bare numbers/state flags/git SHAs; single-character names; engineering artifacts (commit messages, PR titles, build flags, codenames, code variable names, schema fields, CLI flags); Robin's own internals.

If nothing personal is worth extracting, reply {"entities":[],"relations":[]}.`;
```

> Note: `library` and `tool`-as-tech were removed from the type list (they are engineering by definition; `library` was already in `BLOCKED_ENTITY_TYPES`). Leave `BLOCKED_ENTITY_TYPES` unchanged — it stays as the deterministic floor.

(c) `SESSION_SUMMARY_PROMPT` (~164): replace the dev exemplar so the prompt stops teaching dev topics:

```typescript
- topics: 2-7 kebab-case tags at the life/project level (e.g. "whoop-recovery", "nikon-zf-settings", "joshua-tree-trip") — not code symbols. Reuse existing topic tags when the subject matches a prior session.
```

(d) Entity filter loop (~1866): add the domain check (inside the extracted helper from Step 1's note):

```typescript
    for (const e of extracted.entities) {
      if (
        isLowQualityEntity(e.name, e.type) ||
        noiseBlocklist.has(e.name.toLowerCase()) ||
        (domainGating && !isPersonalDomain((e as { domain?: string | null }).domain))
      ) {
        droppedNames.add(e.name.toLowerCase());
        continue;
      }
      filteredEntities.push(e);
    }
```

(The relation filter just below already drops relations whose subject/object landed in `droppedNames` — no change needed there.)

- [ ] **Step 4: Run to verify pass** — biographer test file → PASS. `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/brain/cognition/biographer.ts system/brain/cognition/biographer.test.ts
git commit -m "feat(biographer): personal-domain allowlist for entity extraction"
```

---

### Task 7: Kill-switch — `biographer.domainGating` policy flag

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (`RunBiographerOptions` ~near `draftClaims?` at 647; the local read ~1508)
- Modify: `system/brain/cognition/jobs.ts` (`registerCognitionJobs` signature + the `biographer.run` handler ~74–108)
- Modify: the daemon wiring that calls `registerCognitionJobs` (grep for the call site that passes `getDraftClaims`)
- Test: `system/brain/cognition/biographer.test.ts` (extend) + `system/brain/cognition/jobs.test.ts` if it asserts the handler options

- [ ] **Step 1: Write the failing test:**

```typescript
test('domainGating:false bypasses the allowlist (kill-switch)', async () => {
  // Same mocked extraction as Task 5 (a travel claim + an engineering claim).
  // Run the biographer claims pass with options.domainGating = false.
  // Assert: BOTH claims become pending candidates (gating off = old behavior),
  // result.claimsDropped === 0.
});
```

- [ ] **Step 2: Run to verify fail** (the local `const domainGating = options.domainGating ?? true` from Task 5 exists, but the option isn't on the type / not threaded from jobs).

- [ ] **Step 3: Implement.**

(a) In `biographer.ts`, add to `RunBiographerOptions` (beside `draftClaims?` at ~647):

```typescript
  /**
   * Phase D personal-domain allowlist gate. When true (default), claims/entities
   * outside PERSONAL_DOMAINS are dropped at extraction. Resolved from the
   * `biographer.domainGating` policy at handler time, so a regression is disabled
   * by editing policies.yaml — no daemon restart. Mirrors `draftClaims`.
   */
  domainGating?: boolean;
```

Confirm the read near line 1508 is `const domainGating = options.domainGating ?? true;` (added in Task 5).

(b) In `jobs.ts`, add a `getDomainGating` resolver to `registerCognitionJobs` (mirror `getDraftClaims`, ~78):

```typescript
export function registerCognitionJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  getDraftClaims: () => boolean = () => true,
  getDomainGating: () => boolean = () => true,
): void {
```

And pass it in the `biographer.run` handler's `runBiographer` options (~96):

```typescript
    await runBiographer(db, llm, 30, {
      maxChunksPerTick: 10,
      batchChunks: 5,
      skipToolChunks: true,
      draftClaims: getDraftClaims(),
      domainGating: getDomainGating(),
      tickDeadlineMs: 3 * 60 * 1000,
    });
```

(c) At the daemon call site (grep: `registerCognitionJobs(`), pass a resolver reading the `biographer.domainGating` policy the same way `getDraftClaims` reads `biographer.draftClaims` (locate the policy accessor used for `draftClaims` and add the parallel `domainGating` accessor; default `true`).

- [ ] **Step 4: Run to verify pass** — biographer + jobs test files → PASS. `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/brain/cognition/biographer.ts system/brain/cognition/jobs.ts <daemon-call-site-file>
git commit -m "feat(biographer): biographer.domainGating policy kill-switch"
```

---

### Task 8: Drop-rate signal + `robin memory audit-sample`

**Files:**
- Modify: `system/brain/cognition/biographer.ts` (surface `claimsDropped` in the tick log/result message the way `claimsDrafted` is surfaced)
- Create: `system/surfaces/cli/memory.ts` (`audit-sample` subcommand) — or extend the nearest existing memory/beliefs CLI file if one already owns this surface
- Modify: `system/surfaces/cli/index.ts` (route + help line)
- Test: `system/surfaces/cli/memory.test.ts`

- [ ] **Step 1: Write the failing test** (deterministic — query layer, no LLM):

```typescript
test('audit-sample groups recent kept extractions by domain', () => {
  // Seed belief_candidates: 2 rows domain='health', 1 row domain='creative',
  // 1 row domain=NULL. Call the sampler function (the CLI's underlying query).
  // Assert it returns counts { health: 2, creative: 1, '(untagged)': 1 } and a
  // sample list capped at the requested N.
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** an exported `sampleByDomain(db, limit)` in `system/surfaces/cli/memory.ts`:

```typescript
import type { RobinDb } from '../../brain/memory/db.ts';

export interface DomainSample {
  counts: Record<string, number>;
  recent: Array<{ id: number; domain: string; topic: string; claim: string }>;
}

/** Spot-audit surface (Phase D metric): recent belief candidates grouped by the
 *  domain tag, so a human can eyeball whether dev junk is being tagged personal. */
export function sampleByDomain(db: RobinDb, limit = 30): DomainSample {
  const rows = db
    .prepare(
      `SELECT id, COALESCE(domain, '(untagged)') AS domain, topic, claim
         FROM belief_candidates
        ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as DomainSample['recent'];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.domain] = (counts[r.domain] ?? 0) + 1;
  return { counts, recent: rows };
}
```

Wire a `memory audit-sample [N]` subcommand that opens the DB the way other CLI files do, calls `sampleByDomain`, and prints the counts table + the sample. Register in `cli/index.ts` routing and help text (`memory audit-sample [N]   Recent extractions grouped by personal domain`). Surface `claimsDropped` in the biographer tick message next to `claimsDrafted` (one-line addition).

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/surfaces/cli/memory.test.ts` → PASS. `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/surfaces/cli/memory.ts system/surfaces/cli/memory.test.ts system/surfaces/cli/index.ts system/brain/cognition/biographer.ts
git commit -m "feat(memory): drop-rate surfacing + robin memory audit-sample"
```

---

### Task 9 (OPTIONAL — spend optimization, recall risk): conservative pure-dev session skip

> Decision 6: the self-capture half of the design's Component 2 is already shipped. This task adds ONLY the pure-dev session skip — an optimization that avoids spending extraction LLM calls on sessions Component 1 would empty anyway. It carries false-negative risk (mis-skip a mixed session → lose a personal fact, the Q3-B error), so it is conservative and skippable. **Skip this task unless extraction spend on pure-dev robin-repo sessions is measured as material.**

**Files:**
- Modify: `system/brain/cognition/capture.ts` (a `looksPureDev(turns)` heuristic + a new skip reason)
- Test: `system/brain/cognition/capture.test.ts` (extend)

- [ ] **Step 1: Write the failing tests:**

```typescript
test('looksPureDev: a session that is all code/tool/command lines with no personal signal is pure-dev', () => {
  assert.equal(looksPureDev(pureDevTurns), true);   // fenced code, tool calls, bash
});
test('looksPureDev: a mixed session with even one personal sentence is NOT pure-dev (fall through)', () => {
  assert.equal(looksPureDev(mixedTurns), false);    // debugging + "I'm flying to Tokyo next week"
});
test('looksPureDev: a short ambiguous session is NOT pure-dev (conservative default)', () => {
  assert.equal(looksPureDev(shortTurns), false);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** a conservative heuristic — only return true when the evidence is overwhelming AND no first-person personal signal is present:

```typescript
/** Conservative pure-dev classifier (Phase D, optional). Returns true ONLY when a
 *  session is overwhelmingly code/tooling AND shows no first-person personal
 *  signal. Default is FALSE — a mis-classification drops real personal facts, the
 *  error we most want to avoid, so ambiguity falls through to per-claim filtering. */
export function looksPureDev(turns: SessionTurn[]): boolean {
  const userText = turns.filter((t) => t.role === 'user').map((t) => t.content).join('\n');
  if (userText.trim().length < 200) return false; // too little to be confident
  // First-person personal signal — if present, never treat as pure-dev.
  if (/\bi(?:'m| am| was| feel| went| bought| ate| flew| have| need)\b/i.test(userText)) return false;
  const lines = userText.split('\n');
  const devLines = lines.filter((l) =>
    /^[\s>]*(```|\$|npm |pnpm |git |cd |grep |const |function |import |export |class )/.test(l) ||
    /\.(ts|tsx|js|json|sql|yaml|yml)\b/.test(l),
  ).length;
  return lines.length >= 10 && devLines / lines.length >= 0.8;
}
```

Wire it into `captureSession` as a new skip reason `pure_dev_session` checked AFTER the existing cwd / assistant-turn / cognition-echo skips, returning `{ captured: false, skipReason: 'pure_dev_session' }`. Gate it behind the same `domainGating` policy so the kill-switch disables it too.

- [ ] **Step 4: Run to verify pass** — capture test file → PASS. `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add system/brain/cognition/capture.ts system/brain/cognition/capture.test.ts
git commit -m "feat(capture): conservative pure-dev session skip (optional, gated)"
```

---

### Task 10: Finalize — gates, build, restart, baseline measurement

- [ ] **Step 1: Full gates.** `pnpm lint && pnpm typecheck && pnpm test` — clean except the 4 known pre-existing failures (spotify ×2, ebird, recall); zero NEW failures.
- [ ] **Step 2: Build + restart.** `pnpm build && launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`. Verify migration 028 applied: `sqlite3 user-data/state/db/robin.sqlite "PRAGMA table_info(belief_candidates);" | grep domain` and the same for `entities`.
- [ ] **Step 3: Baseline + after measurement (the success metric).**
  - Before relying on the change, capture a baseline: `node dist/surfaces/cli/index.js memory audit-sample 50` and hand-label what fraction of the most recent KEPT candidates are engineering-artifacts (this is the pre-change leak rate; pre-Phase-D rows are NULL-domain).
  - After the next few biographer ticks run under gating, re-run `memory audit-sample 50`: new candidates should now all carry a personal `domain`; the engineering-artifact fraction among them should be ≤2%. Watch `claimsDropped` in the daemon log climb (noise being rejected).
  - If recall looks wrong (real personal facts being dropped), flip the kill-switch: set `biographer.domainGating: false` in `policies.yaml` (no restart needed) and investigate against the fixtures.
- [ ] **Step 4: Update `docs/STATUS.md`** (Recent changes — Phase D entry, same style as Phase A/B/C). Commit stragglers with explicit paths only.

---

## Self-review notes (already applied)

- **Spec coverage:** Component 1 → Tasks 5 (claims) + 6 (entities), backed by Task 1 (domain set) and the deterministic backstops kept in place. Component 3 → Tasks 2 (migration) + 3 (candidate threading) + 4 (promotion gate). Kill-switch → Task 7. Success metric → Task 8 (drop-rate + audit-sample) + Task 10 step 3 (baseline). Component 2 → Task 9 (pure-dev skip only; self-capture half noted as already shipped — see decision 6). Component 4 (retroactive cleanup) is the agreed FOLLOW-ON plan, out of scope here.
- **Decision-2 (permissive domain field):** a strict `z.enum` would dead-letter a whole chunk on one unknown tag — the field is a nullable string filtered by `isPersonalDomain`, so a single bad tag drops one item.
- **Decision-1 (grandfather):** new extractions always carry a domain or are dropped; the promotion gate only blocks EXPLICIT non-personal domains so the existing NULL-domain pending queue stays promotable. Tested in Task 4.
- **Type consistency:** `isPersonalDomain` (Task 1) is consumed by the claims loop (Task 5), entity filter (Task 6), and promotion gate (Task 4). `domain?: string | null` is added consistently to `insertBeliefCandidate`/`insertCandidateWithDedup` inputs (Task 3), the `belief_candidates`/`entities` columns (Task 2), and `RawRow` (Task 4). `domainGating` is added to `RunBiographerOptions` (Task 7) and read once (Task 5).
- **Zero new LLM calls:** the domain tag rides the existing per-chunk extraction call; the drop logic, gate, kill-switch, and audit-sample are all deterministic. Prompt length grows by the domain list (~a few hundred tokens/chunk) — within the Phase-C zero-new-*call* stance.
- **Ordering:** Task 1→2 establish the set + column; Task 3 makes inserts domain-aware BEFORE Task 5's loop calls them with a domain; Task 4's gate is independent of the biographer; Task 7's kill-switch is threaded after the gating logic exists (Task 5 ships a default-true local so it compiles standalone). Task 9 is optional and isolated.

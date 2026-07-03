# Nikon Body Operational Reference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Kevin asks a "how do I X / where is X on the Z8/Zf/Zfc/Z50II" question, the relevant operational reference section is already injected into context — no web search — and rare uncovered questions become one targeted manual fetch.

**Architecture:** Reuse auto-recall's existing Layer-1 keyword→doc mechanism (`config/recall-topics.yaml` + `sliceToRelevantSection`). Add per-body curated operational reference docs (keyword-rich H2 sections so the lexical slicer surfaces the right one), a small slicer-aware fix to the stale 16k doctor warn, and precise per-body match terms. No new infrastructure.

**Tech Stack:** Node.js 24, TypeScript (ESM), `node:test` + `node:assert/strict`, Biome, better-sqlite3. Design spec: `docs/design/2026-07-03-nikon-body-operational-reference.md`.

## Global Constraints

- Tests are collocated `foo.ts` → `foo.test.ts`, `node:test` + `assert/strict`. Run a single test file with `pnpm exec tsx --test <file>`.
- `pnpm lint` (Biome) and `pnpm typecheck` must pass; no `any`.
- **`user-data/` is gitignored — NEVER `git add` or commit any file under it** (the 8 content docs + `recall-topics.yaml` live there). Only the repo code/test files (Tasks 1–3) are committed.
- A code change under `system/` needs `pnpm build` + daemon restart (`launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`) to go live. `recall-topics.yaml` and content docs are read fresh per turn (`readFileSync`) — **no restart** needed for those.
- Auto-recall Layer-1 injection is hard-capped at ~4000 chars regardless of file size (`LAYER1_DOC_INLINE_CHARS` in `system/brain/memory/auto-recall.ts`), so reference doc size does not affect per-turn tokens.
- The slicer (`system/brain/memory/section-slice.ts`) is lexical: splits on `##`, scores by query-word overlap, **headings weighted 2×**, substring match, 3-char token floor; no overlap → whole-doc top-truncation.
- **The four match rules, verbatim:**
  ```yaml
    - id: nikon-z8
      match: [z8, "z 8"]
      docs: [content/knowledge/nikon-z8-reference.md]
    - id: nikon-zf
      match: [zf, "z f"]
      docs: [content/knowledge/nikon-zf-reference.md]
    - id: nikon-zfc
      match: [zfc, "z fc"]
      docs: [content/knowledge/nikon-zfc-reference.md]
    - id: nikon-z50ii
      match: [z50ii, "z50 ii", "z 50 ii", z50, "z 50"]
      docs: [content/knowledge/nikon-z50ii-reference.md]
  ```
- **The section skeleton, verbatim** (same 11 H2s in this order in every reference doc; ordered by ask-frequency):
  1. `## Histograms & displays — luminance, RGB / per-channel, highlights & blinkies, DISP cycle`
  2. `## Autofocus — AF-area modes, subject detection, AF-ON / back-button, tracking, focus-shift`
  3. `## Metering & exposure — matrix / spot / highlight-weighted, EV comp, ETTR, bracketing`
  4. `## Custom buttons & i-menu — Fn1/Fn2/AF-ON/lens buttons, i-menu slots`
  5. `## Drive, shutter & silent — release modes, mechanical/EFCS/electronic, flash sync speed`
  6. `## Video — resolution/codec/frame rates, N-Log, zebra/waveform, record limits`
  7. `## Connectivity & transfer — SnapBridge, USB/PC, FTP, tethering`
  8. `## Key custom-setting locations — the a/b/c/d/e/f/g menu addresses people hunt for`
  9. `## Capability facts & specs — sensor, ISO range, buffer, sync speed, card slots, focus-shift support`
  10. `## Firmware-added features — what each firmware version added, with (FW x.y+) tags`
  11. `## Gotchas — body-specific traps (bank drift, U-mode save behavior, etc.)`
- **Stamp format** (top of every reference, immediately under the H1): `Last verified: YYYY-MM-DD · FW <version>`.

---

### Task 1: Make the doctor 16k warn slicer-aware

The `recall.topics_resolvable` invariant flags any mapped doc over `DOC_SIZE_WARN_CHARS` (16k) as "injected whole every turn." That premise predates the slicer — a doc with `##` sections is never injected whole (it's sliced to ≤4000 chars). Fix `validateRecallTopics` to flag an oversized mapped doc **only when it lacks `##` sectioning** (genuinely un-sliceable). This keeps `robin doctor` green for the large Z8/Zf references built later.

**Files:**
- Modify: `system/lib/recall-topics.ts` (function `validateRecallTopics`, ~lines 99–113)
- Test: `system/lib/recall-topics.test.ts` (add one test; existing oversized test stays valid)

**Interfaces:**
- Consumes: `validateRecallTopics(userData: string): { topicCount: number; missingDocs: string[]; oversizedDocs: Array<{ doc: string; chars: number }> }` (unchanged signature)
- Produces: same signature; behavioral change only — `oversizedDocs` now excludes docs that contain at least one `## ` heading.

- [ ] **Step 1: Write the failing test**

Add to `system/lib/recall-topics.test.ts`:

```ts
test('validateRecallTopics: does NOT flag an oversized doc that has ## sections (sliceable)', () => {
  const ud = makeUserData();
  const big = `# Ref\n\n## Section One\n${'B'.repeat(17000)}\n\n## Section Two\nmore`;
  writeFileSync(join(ud, 'content', 'knowledge', 'sectioned.md'), big);
  writeYaml(
    ud,
    `topics:
  - id: huge
    match: [foo]
    docs: [content/knowledge/sectioned.md]
`,
  );
  const result = validateRecallTopics(ud);
  assert.deepEqual(result.missingDocs, []);
  assert.deepEqual(result.oversizedDocs, []); // sectioned → sliceable → not flagged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test system/lib/recall-topics.test.ts`
Expected: the new test FAILS — `oversizedDocs` currently contains `content/knowledge/sectioned.md` (the code still flags purely on size).

- [ ] **Step 3: Implement the slicer-aware check**

In `system/lib/recall-topics.ts`, replace the oversize block inside `validateRecallTopics` (the `try { const { size } = statSync(abs); if (size > DOC_SIZE_WARN_CHARS) oversized.set(doc, size); }` section):

```ts
      try {
        const { size } = statSync(abs);
        if (size > DOC_SIZE_WARN_CHARS) {
          // Post-slicer, an oversized doc with `##` sections is never injected whole —
          // auto-recall slices it to the query-relevant section (≤ the Layer-1 budget).
          // Only an un-sliceable (no-H2) oversized doc actually taxes every turn.
          const content = readFileSync(abs, 'utf8');
          if (!/^##\s+/m.test(content)) oversized.set(doc, size);
        }
      } catch {
        // stat/read failed (race, perms) — treat as resolvable; missing-check already passed.
      }
```

(`readFileSync` is already imported at the top of the file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test system/lib/recall-topics.test.ts`
Expected: PASS — the new sectioned-doc test passes, AND the existing `validateRecallTopics: flags an oversized doc` test still passes (its `'B'.repeat(17000)` fixture has no `##`, so it stays un-sliceable → still flagged). Update that existing test's title to `flags an oversized doc that is un-sliceable (no H2)` for clarity.

- [ ] **Step 5: Lint, typecheck, build, restart**

Run: `pnpm lint && pnpm typecheck && pnpm build`
Expected: all clean.
Then: `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`
Then verify the CLI sees the new code: `robin doctor 2>&1 | grep -i topics_resolvable` → should report ok (no oversized false-positive).

- [ ] **Step 6: Commit**

```bash
git add system/lib/recall-topics.ts system/lib/recall-topics.test.ts
git commit -m "fix(recall): make topics_resolvable 16k warn slicer-aware (only flag un-sliceable docs)"
```

---

### Task 2: Lock the word-boundary guarantee (cross-fire regression test)

The whole retrieval design depends on `matchTopics` NOT cross-firing between body terms (`\bzf\b` must not match "zfc", `\bz50\b` must not match "z50ii"). `matchTopics` already does this correctly; this test locks it against regression, using inline rules shaped like the real body rules (the real rules live in gitignored `recall-topics.yaml`, so we test the matcher, not Kevin's config).

**Files:**
- Test: `system/lib/recall-topics.test.ts` (add one test)

**Interfaces:**
- Consumes: `matchTopics(prompt: string, rules: TopicRule[]): TopicRule[]` where `TopicRule = { id: string; match: string[]; docs: string[] }`.

- [ ] **Step 1: Write the test**

Add to `system/lib/recall-topics.test.ts`:

```ts
test('matchTopics: Nikon body terms do not cross-fire (word-boundary)', () => {
  const rules = [
    { id: 'nikon-zf', match: ['zf', 'z f'], docs: ['zf.md'] },
    { id: 'nikon-zfc', match: ['zfc', 'z fc'], docs: ['zfc.md'] },
    { id: 'nikon-z50ii', match: ['z50ii', 'z50 ii', 'z50'], docs: ['z50.md'] },
  ];
  // "zfc" must hit ONLY the zfc rule — \bzf\b does not match inside "zfc".
  assert.deepEqual(
    matchTopics('how do I focus-shift on my zfc', rules).map((r) => r.id),
    ['nikon-zfc'],
  );
  // "z50ii" must hit ONLY z50ii — \bz50\b does not match inside "z50ii".
  assert.deepEqual(
    matchTopics('AF modes on the z50ii', rules).map((r) => r.id),
    ['nikon-z50ii'],
  );
  // bare "zf" hits ONLY zf.
  assert.deepEqual(
    matchTopics('metering on the zf', rules).map((r) => r.id),
    ['nikon-zf'],
  );
});
```

- [ ] **Step 2: Run the test — expect PASS**

Run: `pnpm exec tsx --test system/lib/recall-topics.test.ts`
Expected: PASS (this documents/locks existing correct behavior). If it FAILS, the matcher regressed — stop and investigate before continuing.

- [ ] **Step 3: Commit**

```bash
git add system/lib/recall-topics.test.ts
git commit -m "test(recall): lock word-boundary cross-fire guarantee for Nikon body terms"
```

---

### Task 3: Prove keyword-rich headings slice correctly (authoring-pattern test)

The reference docs only work if the slicer picks the right section from its heading. This test contrasts a **keyword-rich** heading (slices correctly) against a **keyword-poor** heading (falls back to whole-doc), demonstrating the authoring rule the content build must follow.

**Files:**
- Test: `system/brain/memory/section-slice.test.ts` (add two tests)

**Interfaces:**
- Consumes: `sliceToRelevantSection(body: string, query: string, opts?: { minBodyChars?: number; maxSections?: number; maxChars?: number }): string`

- [ ] **Step 1: Write the tests**

Add to `system/brain/memory/section-slice.test.ts`:

```ts
/** A reference doc shaped like the Nikon body-reference template. */
function refDoc(histogramHeading: string): string {
  return [
    '# Nikon Z8 — Operational Reference',
    'Last verified: 2026-07-03 · FW 2.10',
    '',
    `## ${histogramHeading}`,
    'Playback RGB / per-channel histogram: MENU → Playback display options → enable',
    'RGB histogram; cycle with DISP in playback. Red channel clips first under tungsten.',
    'x'.repeat(1000),
    '',
    '## Autofocus — AF-area modes, subject detection, AF-ON / back-button',
    'Back-button AF: assign AF-ON, disable shutter-button AF in custom settings.',
    'y'.repeat(1000),
  ].join('\n');
}

test('keyword-rich heading slices to the histogram section', () => {
  const out = sliceToRelevantSection(
    refDoc('Histograms & displays — luminance, RGB / per-channel, highlights & blinkies'),
    'how do I see the per-channel histogram',
  );
  assert.match(out, /Histograms & displays/);
  assert.match(out, /RGB histogram/);
  assert.doesNotMatch(out, /Back-button AF/); // did NOT return the Autofocus section
});

test('keyword-poor heading fails to slice (falls back to whole doc)', () => {
  // Heading with none of the query words → no lexical overlap → whole-doc fallback.
  const doc = refDoc('Displays');
  const out = sliceToRelevantSection(doc, 'per-channel histogram');
  assert.equal(out, doc); // fell back — proves why headings must carry the keywords
});
```

- [ ] **Step 2: Run the tests — expect PASS**

Run: `pnpm exec tsx --test system/brain/memory/section-slice.test.ts`
Expected: PASS. Both assertions hold: "histogram" ∈ "Histograms" (heading, 2× weight) wins; the bare "Displays" heading shares no query token, so it returns the whole doc unchanged.

- [ ] **Step 3: Commit**

```bash
git add system/brain/memory/section-slice.test.ts
git commit -m "test(recall): assert keyword-rich headings slice, poor headings fall back"
```

---

### Task 4: Reference template + Z8 exemplar (content — gitignored)

Build the Z8 reference first as the normalization exemplar (the most feature-rich body). This locks the template shape before fanning out. **These files are under `user-data/` — gitignored, never committed.**

**Files:**
- Create: `user-data/content/knowledge/nikon-z8-reference.md`
- Create: `user-data/content/knowledge/nikon-z8-manual-map.md`
- Reference (read, do not modify): `user-data/content/knowledge/photo-z8-setup-guide.md`, `nikon-user-modes-and-banks.md`, `video-z8-setup.md`

**Interfaces:**
- Produces: `content/knowledge/nikon-z8-reference.md` (the template all later bodies match), consumed by Task 5 (as exemplar) and Task 6 (recall-topics mapping).

- [ ] **Step 1: Dispatch a build agent for the Z8**

Use the Agent tool (general-purpose) with this instruction:

> Build `user-data/content/knowledge/nikon-z8-reference.md`, an operational reference for the Nikon Z8. Fill EXACTLY this 11-section skeleton (verbatim H2 headings, in this order): [paste the 11 headings from Global Constraints]. Directly under the H1 put the stamp `Last verified: 2026-07-03 · FW <current Z8 firmware>`. Content rules: (1) each section is menu paths + settings + gotchas + capability facts, ~1.5–2.5k chars, NOT technique prose; (2) tag any firmware-gated fact `(FW x.y+)`; (3) name synonyms users type ("blinkies"/"highlight display", "AF-ON"/"back-button"); (4) cross-link the Video section to `video-z8-setup.md` rather than duplicating it; (5) fold in facts from `photo-z8-setup-guide.md` and `nikon-user-modes-and-banks.md`. Source menu paths from Nikon's official Z8 online manual (onlinemanual.nikonimglib.com/z8/en/) — fetch only the TOC + the ~15–25 pages matching the skeleton sections, not the whole manual. Also create `user-data/content/knowledge/nikon-z8-manual-map.md`: the manual base/TOC URL plus one line per high-value section → its exact manual URL (the pages you fetched). Return both file paths.

- [ ] **Step 2: Review the exemplar**

Read `nikon-z8-reference.md`. Confirm: all 11 headings present verbatim; stamp present; per-channel-histogram answer is in the Histograms section; no technique-prose bloat; FW tags where relevant. Fix anything off before proceeding — this doc is the template for the other three.

- [ ] **Step 3: Acceptance — live slice check**

Write `/private/tmp/claude-501/-Users-iser-workspace-robin-robin-assistant-v3/17616b83-cffc-4fd3-81ea-63abfe8d2232/scratchpad/slice-check.ts`:

```ts
import { readFileSync } from 'node:fs';
import { sliceToRelevantSection } from '../../../system/brain/memory/section-slice.ts';
const doc = readFileSync(process.argv[2], 'utf8');
console.log(sliceToRelevantSection(doc, process.argv[3]));
```

Run: `pnpm exec tsx <scratchpad>/slice-check.ts user-data/content/knowledge/nikon-z8-reference.md "how do I see the per-channel histogram"`
Expected: output begins `Nikon Z8 — Operational Reference › Histograms & displays …` and contains the RGB-histogram menu path. If it returns a different section or the whole doc, the Histograms heading isn't keyword-rich enough — fix the heading/body and re-run.

- [ ] **Step 4: No commit (gitignored)**

`user-data/` is gitignored. Confirm with `git status --porcelain user-data/` → no output (nothing staged). Do NOT `git add` these files.

---

### Task 5: Fan out Zf, Zfc, Z50II references (content — gitignored)

Replicate the Z8 exemplar for the remaining three bodies in parallel, then normalize.

**Files:**
- Create: `user-data/content/knowledge/nikon-zf-reference.md` + `nikon-zf-manual-map.md`
- Create: `user-data/content/knowledge/nikon-zfc-reference.md` + `nikon-zfc-manual-map.md`
- Create: `user-data/content/knowledge/nikon-z50ii-reference.md` + `nikon-z50ii-manual-map.md`
- Reference (read): `zf-night-flash-cheatsheet.md`, `photo-bird-af-z50ii.md`, `nikon-user-modes-and-banks.md`

**Interfaces:**
- Consumes: `nikon-z8-reference.md` (exemplar shape from Task 4).
- Produces: three reference docs matching the exemplar, consumed by Task 6.

- [ ] **Step 1: Dispatch three build agents in parallel**

Dispatch three Agent (general-purpose) tasks in ONE message. Each uses the same instruction as Task 4 Step 1, but for its body, with these substitutions:
- **Zf:** manual `onlinemanual.nikonimglib.com/zf/en/`; fold in `zf-night-flash-cheatsheet.md`; stamp `· FW <current Zf firmware>`.
- **Zfc:** manual `onlinemanual.nikonimglib.com/zfc/en/`; stamp `· FW <current Zfc firmware>`.
- **Z50II:** manual `onlinemanual.nikonimglib.com/z50ii/en/`; fold in `photo-bird-af-z50ii.md`; stamp `· FW <current Z50II firmware>`.
Add to each: "Match the structure of the exemplar at `user-data/content/knowledge/nikon-z8-reference.md` exactly — same H2 headings verbatim, same ordering, same stamp format."

- [ ] **Step 2: Normalization pass**

Read all four references side by side. Confirm identical H2 headings (verbatim), consistent depth and phrasing, and that DX-only quirks (Z50II/Zfc: EN-EL25, no top-plate LCD, U1/U2/U3 user modes vs the Z8's banks) are captured. Reconcile any drift so the slicer behaves uniformly.

- [ ] **Step 3: Acceptance — slice check each body**

For each of the three docs, run `slice-check.ts` (from Task 4) with a body-appropriate question and confirm it returns the intended section:
- `nikon-zf-reference.md` "how do I set back-button focus" → Autofocus section.
- `nikon-zfc-reference.md` "where is the flash sync speed" → Drive/shutter section.
- `nikon-z50ii-reference.md` "does it do focus shift shooting" → Autofocus or Capability section.
Expected: each returns the intended section with a breadcrumb, not the whole doc.

- [ ] **Step 4: No commit (gitignored)**

Confirm `git status --porcelain user-data/` → no output. Do NOT `git add`.

---

### Task 6: Wire the recall-topics rules + end-to-end verification (config — gitignored)

Register the four rules now that all four docs exist (registering earlier would make `robin doctor` flag the not-yet-built docs as missing).

**Files:**
- Modify: `user-data/config/recall-topics.yaml` (append the four rules)

**Interfaces:**
- Consumes: the four `nikon-<body>-reference.md` docs (Tasks 4–5), the slicer-aware invariant (Task 1, already built + live).

- [ ] **Step 1: Append the four rules**

Add the verbatim YAML block from Global Constraints to `user-data/config/recall-topics.yaml` under `topics:` (after the existing `photography` topic). Keep the file's existing comment style.

- [ ] **Step 2: Verify the mapping resolves**

Run: `robin doctor 2>&1 | grep -iA2 topics_resolvable`
Expected: ok. All four docs resolve (present), and none is flagged oversized (Task 1's fix — they're sectioned). If a doc is flagged missing, fix the path; if flagged oversized, confirm it has `##` headings and that Task 1's build/restart actually landed.

- [ ] **Step 3: End-to-end injection check**

Confirm the terms fire and slice via the matcher + slicer path. Run:
`pnpm exec tsx <scratchpad>/slice-check.ts user-data/content/knowledge/nikon-z8-reference.md "how do i see per channel histogram in z8"`
Expected: returns the Histograms section (the real question that motivated this feature). The `recall-topics.yaml` is read live per turn, so no restart is needed — a fresh prompt containing "z8" will now inject this section.

- [ ] **Step 4: Ingest for the Layer-2 backstop (optional but recommended)**

If knowledge ingestion is not automatic on the daemon tick, run the project's ingest path so the new docs are vector-indexed (Layer-2 recall backstops Layer-1 when a keyword misses). Check: `robin recall --debug "nikon z8 rgb histogram" 2>&1 | head` should surface the Z8 reference. If ingestion is automatic, note that it will pick them up on the next scheduled pass.

- [ ] **Step 5: No commit (gitignored)**

Confirm `git status --porcelain user-data/` → no output. The only committed changes for this feature are Tasks 1–3 (repo code/tests) and the two design docs.

---

## Self-Review

**Spec coverage:**
- Content gap (per-body ops reference) → Tasks 4, 5. ✓
- Retrieval gap (precise match terms, word-boundary) → Task 6 (rules) + Task 2 (regression lock). ✓
- Slicer-driven doc structure (keyword-rich headings, skeleton, ordering, stamp) → Global Constraints + Tasks 4/5 + Task 3 (pattern proof). ✓
- Manual-map (base/TOC + high-value URLs, not force-injected) → Tasks 4/5 Step 1. ✓
- Size handling / stale 16k invariant → Task 1. ✓
- Freshness (stamp, bounded verify, stamp-advance loop) → stamp in Global Constraints + Tasks 4/5; the bounded-verify/stamp-advance behavior is Robin's answer-time discipline (documented in the spec), not a code artifact — no task needed. ✓
- Build (fan-out, template, normalization, ingestion) → Tasks 4, 5, 6 Step 4. ✓
- Testing (unit cross-fire, slice-assertion, doctor, live e2e) → Tasks 2, 3, 6. ✓

**Placeholder scan:** No TBD/TODO. Firmware `<version>` in stamps is a genuine runtime value the build agent fills from the live manual, not a plan placeholder. All code steps show complete code.

**Type consistency:** `validateRecallTopics` signature unchanged across Task 1. `matchTopics`/`TopicRule` in Task 2 match `recall-topics.ts`. `sliceToRelevantSection` signature in Task 3/slice-check matches `section-slice.ts`. Doc paths are identical across Global Constraints, the YAML block, and Tasks 4–6.

**Gap note:** the manual-map files land under `content/knowledge/` and would be vector-indexed; harmless (they're Kevin's own URLs, curated kinds only), and not worth a separate un-indexed location. Flagged in the spec; no task.

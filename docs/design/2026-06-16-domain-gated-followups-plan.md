# Domain-Gated Memory — Deferred Follow-ups Plan (Phase D, Components 2 & 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the two deferred pieces of Phase D — (2) a conservative pure-dev session skip that saves extraction spend, and (4) a retroactive `robin memory degate` sweep that culls the dev/engineering belief candidates already sitting untagged in the store.

**Architecture:** Component 2 adds a conservative `looksPureDev(turns)` heuristic to `capture.ts` and a `pure_dev_session` skip (gated by the same `domainGating` policy). Component 4 adds `degate-candidates.ts` (mirrors `canonicalize-heads.ts`: dry-run default, audit events, idempotent, reversible reject) + a `robin memory degate [--apply] [--llm]` CLI — deterministic classification (`isLowQualityClaim`) free by default, an opt-in batched LLM domain pass for the ambiguous remainder.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3, `node:test` + `assert/strict`.

**Spec:** `docs/design/2026-06-16-domain-gated-memory-design.md` (Components 2 & 4). Builds on shipped Phase D (Components 1 & 3, on main at 05bdb23).

**Conventions:** single test file `pnpm exec tsx --test <file>`; full gates `pnpm lint && pnpm typecheck && pnpm test`. Commit author `kevin.kik.lee@gmail.com`. **Never `git add -A`** — explicit paths. The daemon edits the main tree concurrently (we work in an isolated worktree).

**Decisions baked in:**
1. **Component 2 is conservative by construction.** `looksPureDev` returns true ONLY on overwhelming code/tool evidence AND no first-person personal signal. Default false. A mis-skip drops a real personal fact (the worst error per Q3-B), so ambiguity falls through to Component 1's per-claim filter. Gated by `domainGating` so the kill-switch disables it too.
3. **Component 4 is reversible, not destructive.** Culled candidates are `status='rejected', resolved_reason='degate-engineering'` (the same non-destructive mechanism as `dedupePendingCandidates`), never hard-deleted. Dry-run default; `--apply` writes `memory.degate` audit events; idempotent (acts only on `status='pending'`).
4. **Component 4 scope = pending belief_candidates only (first cut).** Entities are already swept by nightly `runHygiene`; promoted-belief retraction is a higher-stakes follow-up. The baseline's untagged dev junk (DATABENTO_API_KEY, Robinhood MCP, repos) lives in pending candidates.
5. **Zero-new-LLM-spend by default.** The deterministic pass (`isLowQualityClaim`) is free and on by default. The LLM domain pass is `--llm`-gated and **batched** (≤25 candidates/call) so cleaning the ~612-candidate backlog is ~25 calls, not 612 — but it stays opt-in (tight subscription limits).

---

### Task A: Component 2 — conservative pure-dev session skip

**Files:**
- Modify: `system/brain/cognition/capture.ts` (add `looksPureDev`; add a `pure_dev_session` skip in `captureSession`)
- Test: `system/brain/cognition/capture.test.ts` (extend)

- [ ] **Step 1: Write failing tests:**

```typescript
test('looksPureDev: all code/tool/command, no personal signal → true', () => {
  assert.equal(looksPureDev(pureDevTurns), true);
});
test('looksPureDev: a mixed session with one first-person personal line → false', () => {
  assert.equal(looksPureDev(mixedTurns), false); // "I'm flying to Tokyo next week" present
});
test('looksPureDev: short/ambiguous session → false (conservative default)', () => {
  assert.equal(looksPureDev(shortTurns), false);
});
test('captureSession skips a pure-dev session with skipReason pure_dev_session (gating on)', async () => {
  const r = await captureSession(db, null, { sessionId: 'd1', turns: pureDevTurns });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'pure_dev_session');
});
test('captureSession does NOT skip when domainGating is off', async () => {
  const r = await captureSession(db, null, { sessionId: 'd2', turns: pureDevTurns, domainGating: false });
  assert.notEqual(r.skipReason, 'pure_dev_session');
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** in `capture.ts`:

```typescript
/** Conservative pure-dev classifier (Phase D, Component 2). Returns true ONLY when a
 *  session is overwhelmingly code/tooling AND shows no first-person personal signal.
 *  Default FALSE — a mis-classification drops real personal facts, the error we most
 *  want to avoid, so ambiguity falls through to the per-claim allowlist. */
export function looksPureDev(turns: SessionTurn[]): boolean {
  const userText = turns.filter((t) => t.role === 'user').map((t) => t.content).join('\n');
  if (userText.trim().length < 200) return false; // too little to be confident
  if (/\bi(?:'m| am| was| feel| went| bought| ate| flew| have| need| like| love)\b/i.test(userText))
    return false; // first-person personal signal → never pure-dev
  const lines = userText.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 10) return false;
  const devLines = lines.filter(
    (l) =>
      /^[\s>]*(```|\$|npm |pnpm |git |cd |grep |const |function |import |export |class |sudo |docker )/.test(l) ||
      /\.(ts|tsx|js|jsx|json|sql|ya?ml|sh|py|rs)\b/.test(l),
  ).length;
  return devLines / lines.length >= 0.8;
}
```

Add `domainGating?: boolean` to the `captureSession` options type (default `true`). In `captureSession`, AFTER the existing cwd / no-assistant-turn / claude-system-notice / cognition-echo skips and BEFORE the dedup write, add:

```typescript
  const domainGating = options.domainGating ?? true;
  if (domainGating && looksPureDev(capture.turns)) {
    return { captured: false, skipReason: 'pure_dev_session' };
  }
```

(Use the actual local variable holding the parsed turns — read the function to find it, e.g. `capture.turns`. Place the check where the other `skipReason` early-returns live.)

- [ ] **Step 4: Run to verify PASS** (whole `capture.test.ts`). `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git -c user.email=kevin.kik.lee@gmail.com add system/brain/cognition/capture.ts system/brain/cognition/capture.test.ts
git -c user.email=kevin.kik.lee@gmail.com commit -m "feat(capture): conservative pure-dev session skip (Phase D Component 2, gated)"
```

---

### Task B: Component 4 — `degate-candidates.ts` (cull engineering candidates)

**Files:**
- Create: `system/brain/memory/degate-candidates.ts`
- Test: `system/brain/memory/degate-candidates.test.ts`

Mirror `system/brain/memory/canonicalize-heads.ts` (read it) for structure, dry-run/apply, audit events, idempotency.

- [ ] **Step 1: Write failing tests:**

```typescript
test('deterministic pass culls a dev-artifact candidate, keeps a personal one (apply)', async () => {
  // insert two pending candidates: one isLowQualityClaim-positive (e.g. claim mentioning "MCP servers"),
  // one clean personal ("Kevin lives in Astoria"). Run degateCandidates(db, null, { apply: true }).
  // assert: the dev one is status='rejected' resolved_reason='degate-engineering';
  //         the personal one stays 'pending'; result.culled === 1.
});
test('dry-run writes nothing', async () => {
  // apply:false → both stay pending, result reports culled count, zero status changes.
});
test('idempotent: a second apply run culls nothing new', async () => {});
test('only acts on pending candidates (already-resolved rows untouched)', async () => {});
test('llm pass culls a non-personal-domain candidate the deterministic pass missed', async () => {
  // a candidate that ISN'T isLowQualityClaim-positive but is engineering by domain
  // (e.g. "Kevin's trading service is a hybrid integrated with the assistant").
  // mock the LLM to classify it 'engineering'; degateCandidates(db, mockLlm, { apply:true, useLlm:true })
  // → rejected. A personal one the mock classifies 'finance' stays pending.
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** `degate-candidates.ts`:

```typescript
import { isLowQualityClaim } from './belief-quality.ts';
import type { RobinDb } from './db.ts';
import { isPersonalDomain, PERSONAL_DOMAINS } from './domains.ts';
import { ingest } from './ingest.ts';
import { sqliteUtc } from './belief-candidate.ts'; // if exported; else inline new Date().toISOString() per file idiom
import type { LLMDispatcher } from '../llm/dispatcher.ts';

export interface DegateResult {
  scanned: number;
  culled: number;
  keptDeterministic: number;
  llmClassified: number;
  samples: Array<{ id: number; topic: string; claim: string; reason: string }>;
}

const LLM_BATCH = 25;

/**
 * Retroactive cleanup (Phase D, Component 4): cull pending belief candidates that are
 * dev/engineering artifacts, NOT facts about Kevin's life. Mirrors the canonicalize
 * sweep — dry-run by default, reversible reject (status='rejected',
 * resolved_reason='degate-engineering'), `memory.degate` audit event on apply,
 * idempotent (acts only on status='pending').
 *
 * Two passes: (1) DETERMINISTIC and free — isLowQualityClaim catches known dev
 * artifacts. (2) OPTIONAL LLM (useLlm) — batched domain classification of the
 * remainder; anything not in PERSONAL_DOMAINS is culled. Off by default (subscription
 * cost). `max` bounds how many pending rows are considered per run.
 */
export async function degateCandidates(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { apply?: boolean; useLlm?: boolean; max?: number } = {},
): Promise<DegateResult> {
  const max = opts.max ?? 10_000;
  const rows = db
    .prepare(
      `SELECT id, topic, claim FROM belief_candidates
        WHERE status = 'pending' AND domain IS NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .all(max) as Array<{ id: number; topic: string; claim: string }>;

  const result: DegateResult = { scanned: rows.length, culled: 0, keptDeterministic: 0, llmClassified: 0, samples: [] };
  const cull = (id: number, topic: string, claim: string, reason: string) => {
    if (opts.apply) {
      db.prepare(
        `UPDATE belief_candidates SET status='rejected', resolved_at=?, resolved_reason='degate-engineering' WHERE id=? AND status='pending'`,
      ).run(new Date().toISOString(), id);
    }
    result.culled++;
    if (result.samples.length < 25) result.samples.push({ id, topic, claim, reason });
  };

  // Pass 1: deterministic.
  const remainder: typeof rows = [];
  for (const r of rows) {
    if (isLowQualityClaim(r.topic, r.claim)) cull(r.id, r.topic, r.claim, 'dev-artifact');
    else remainder.push(r);
  }

  // Pass 2: optional batched LLM domain classification of the remainder.
  if (opts.useLlm && llm && remainder.length > 0) {
    for (let i = 0; i < remainder.length; i += LLM_BATCH) {
      const batch = remainder.slice(i, i + LLM_BATCH);
      const classified = await classifyDomains(llm, batch); // Map<id, domain-string>
      for (const r of batch) {
        result.llmClassified++;
        const d = classified.get(r.id);
        if (!isPersonalDomain(d)) cull(r.id, r.topic, r.claim, `llm:${d ?? 'engineering'}`);
        else result.keptDeterministic++;
      }
    }
  } else {
    result.keptDeterministic += remainder.length;
  }

  if (opts.apply && result.culled > 0) {
    ingest(db, llm, {
      kind: 'memory.degate',
      source: 'maintenance',
      content: `degate: culled ${result.culled}/${result.scanned} pending candidates (llm=${!!opts.useLlm})`,
      payload: { ...result, external_id: `degate:${new Date().toISOString().slice(0, 10)}` },
    });
  }
  return result;
}
```

Implement `classifyDomains(llm, batch)`: one `llm.invoke('reasoning', …)` per batch with a prompt listing `PERSONAL_DOMAINS` + `engineering`, asking for JSON `[{id, domain}]`; parse defensively (a parse failure → treat the whole batch as KEPT, never cull on uncertainty — recall bias). Return `Map<number,string>`.

- [ ] **Step 4: Run to verify PASS.** `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git -c user.email=kevin.kik.lee@gmail.com add system/brain/memory/degate-candidates.ts system/brain/memory/degate-candidates.test.ts
git -c user.email=kevin.kik.lee@gmail.com commit -m "feat(memory): degateCandidates — reversible cull of engineering belief candidates"
```

---

### Task C: `robin memory degate` CLI

**Files:**
- Modify: `system/surfaces/cli/memory.ts` (add a `degate` subcommand to the existing `runMemoryCommand`)
- Modify: `system/surfaces/cli/index.ts` (help line)
- Test: `system/surfaces/cli/memory.test.ts` (extend if practical)

- [ ] **Step 1:** In `runMemoryCommand`, add `else if (sub === 'degate')`: parse `--apply` and `--llm` flags; open the DB the way `audit-sample` does; if `--llm`, get the LLM dispatcher the way other LLM-using CLI commands do (grep an existing one — e.g. `biographer.ts` CLI or `beliefs canonicalize`), else pass `null`; call `degateCandidates(db, llm, { apply, useLlm })`; print the decision table (scanned / culled / kept / llmClassified) + the sample list (`#id [reason] topic: claim`). Default (no `--apply`) is dry-run.
- [ ] **Step 2:** Register a help line in `cli/index.ts`: `memory degate [--apply] [--llm]   Cull engineering belief candidates (dry-run default)`.
- [ ] **Step 3:** Run `pnpm exec tsx --test system/surfaces/cli/memory.test.ts`; `pnpm typecheck`.
- [ ] **Step 4: Commit**

```bash
git -c user.email=kevin.kik.lee@gmail.com add system/surfaces/cli/memory.ts system/surfaces/cli/index.ts system/surfaces/cli/memory.test.ts
git -c user.email=kevin.kik.lee@gmail.com commit -m "feat(cli): robin memory degate — cull engineering candidates (dry-run default)"
```

---

### Task D: Finalize

- [ ] Full gates: `pnpm lint && pnpm typecheck && pnpm test` — zero new failures.
- [ ] Build, merge to main, kickstart daemon (same as Phase D activation).
- [ ] Live: `robin memory degate` (deterministic dry-run) → review → `robin memory degate --apply` (deterministic cull, after a DB snapshot). Present the `--llm` option (≈ backlog/25 batched calls) for explicit opt-in rather than auto-running it.

## Out of scope (this plan)
- Entity culling (nightly `runHygiene` already handles noise entities).
- Promoted-belief retraction (higher-stakes; separate careful pass).
- Wiring Component 2's skip into a policy beyond the shared `domainGating` flag.

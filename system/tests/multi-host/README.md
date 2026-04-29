# Multi-Host Validation

Validates that lazy-loading invariants hold on each frontier host. Without this,
aggressive Tier 1/2 tiering ships and a host quietly stops following pointers
months later.

## Hosts covered

| Host | Pointer file | Automation |
|---|---|---|
| Claude Code | `CLAUDE.md` → `AGENTS.md` | `runners/claude-code.sh` |
| Cursor | `AGENTS.md` (native) | `runners/cursor.md` (manual) |
| Codex | `AGENTS.md` (native) | `runners/codex.sh` |
| Gemini CLI | `GEMINI.md` → `AGENTS.md` | `runners/gemini-cli.sh` |
| Antigravity | `AGENTS.md` (native, v1.20.3+) | `runners/antigravity.md` (manual) |

Cursor and Antigravity are IDE-bound; their runners are 5-minute manual
checklists. Everything else has a headless invocation.

## Six scenarios

| # | Scenario | What it probes |
|---|---|---|
| 1 | Cold-session load | Tier 1 reads in declared order; no Tier 2 leaks |
| 2 | Routine capture | Inbox tag without loading capture-rules.md |
| 3 | Triggered protocol | On-demand fetch of `system/jobs/<name>.md` |
| 4 | Reference fetch | On-demand fetch of `system/manifest.md` |
| 5 | Multi-session detection | `state/sessions.md` is read at startup |
| 6 | Direct-write correction | `self-improvement/corrections.md` write path |

Each scenario file in `scenarios/` documents the prompt, setup steps, and pass
criteria. The `validate-host.js` checker consumes a transcript (host's tool-call
log) and reports per-scenario pass/fail.

## Pass classification

- **HARD FAIL** — Tier 1 file not read (rules invisible to the agent). Blocks
  Phase 2 merge.
- **SOFT FAIL** — extra Tier 2 read (token regression, behavior intact).
  Tracked, doesn't block.
- **SOFT NOTE** — host doesn't expose all internal reads. Document; interpret
  with judgment.

## Running

Per host:

```sh
# Automated hosts
bash system/tests/multi-host/runners/claude-code.sh
bash system/tests/multi-host/runners/codex.sh
bash system/tests/multi-host/runners/gemini-cli.sh

# Manual hosts — open the .md and follow the checklist
$EDITOR system/tests/multi-host/runners/cursor.md
$EDITOR system/tests/multi-host/runners/antigravity.md
```

Each runner writes a transcript to `transcripts/<host>/<scenario>/<date>.txt`
(gitignored — may contain personal data) and invokes:

```sh
node system/scripts/validate-host.js \
  --host=<name> \
  --transcript=<path> \
  --scenario=<n>
```

## Drift detection

`system/jobs/host-validation.md` is a quarterly job (default `enabled: false`).
When enabled, it surfaces a reminder via `state/jobs/INDEX.md` so the user can
re-run validations and catch host-update drift.

## Result format

```json
{
  "host": "claude-code",
  "host_version": "...",
  "model": "opus-4-7",
  "model_version": "...",
  "scenario": 1,
  "result": "pass|hard-fail|soft-fail|soft-note",
  "transcript_ref": "transcripts/claude-code/01/2026-04-29.txt",
  "details": []
}
```

Results aggregate to `results-<date>.md` (gitignored).

## Limitation: absence-of-read

Verifying "did NOT read X" requires a complete tool-call log. Most hosts expose
that, but some elide system reads. Scenarios mark such cases as SOFT NOTE
rather than fail.

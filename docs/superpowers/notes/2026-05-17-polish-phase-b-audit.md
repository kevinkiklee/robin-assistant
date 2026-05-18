# Polish Phase B — Audit Notes

**Date range:** 2026-05-17 →
**Phase B complete:**

## B.1 CLI ergonomics

### Inventory (B.1 Step 0 — audit current surface)
(populated by Task 1)

### Decisions
| Command | --help? | --json? | Exit codes used | Sibling group | Action | Commit |
|---|---|---|---|---|---|---|
| (B.1 Tasks 5+6) — `--help` was previously a no-op on every leaf command. Rather than touch 69 files, wired a centralized `--help` early-out in `dispatchFor` that prints `usage + summary + Related:` for any leaf or group, sourcing the summary from `command-registry.js` and the `Related:` footer from `appendRelated()`. Argv mapping (registry name → argv) lives in `command-registry.js`'s `argvFor()`. | central | n/a | n/a | n/a | central dispatcher | accc2b4 + 06e629f |
| all 69 dispatchable commands | yes (via central dispatcher) | n/a | 0 on `--help` | per registry `group` | omnibus snapshot test asserts exit 0, summary present, ≥30 commands w/ Related: | d467bfe |
| 66 commands with siblings | yes | n/a | 0 | yes | Related: footer in --help via central dispatcher | 06e629f |
| skipped (non-dispatchable): version, surreal-install, surreal-ensure-running, brief-gallery, mcp-ensure-running, help | n/a (CLI flag / obsolete registry entry) | n/a | n/a | n/a | skipped in snapshot test | n/a |

## B.2 Doctor + health redesign

### Decisions
| Subarea | Action | Commit |
|---|---|---|

## B.3 Agent-facing UX

### Discord matrix
| Case | Test status | Commit |
|---|---|---|

### MCP tool result shapes
| Tool | Legacy reason | Enum reason | Commit |
|---|---|---|---|

## B.4 Memory output polish

### Decisions
| Helper / Tool | Snapshot test | Commit |
|---|---|---|

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for prompt-injection lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|

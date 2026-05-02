---
name: lint
triggers: ["lint the wiki", "health check memory", "lint", "check memory health"]
description: Health-check the knowledge base for contradictions, stale claims, orphan pages, dead links, missing pages, and data gaps.
runtime: "agent"
enabled: false
timeout_minutes: 15
---
# Protocol: Lint

On-demand health check of the knowledge base. Surfaces semantic problems that Dream's automated maintenance doesn't catch — contradictions between files, stale claims, orphan pages, dead links, and data gaps.

## Trigger

On-demand only. User says "lint the wiki," "health check memory," or similar. Not auto-triggered by Dream — lint is interactive because it surfaces issues that need user judgment.

## Scope

Lint accepts an optional scope parameter to limit the check to a subdirectory:

- `lint medical` — only checks `knowledge/medical/` and its LINKS.md edges
- `lint finance` — only checks `knowledge/finance/` and its LINKS.md edges
- `lint all` — full wiki scan (default if no scope given)

## Checks

Run these in order. Stop after finding the issue cap (default 10, override with `--limit N`).

### 1. Contradictions

Compare facts across files connected by LINKS.md edges. Only compare files that share a cross-reference — do not scan all file pairs.

For each edge in LINKS.md (within scope): read both files, look for facts about the same entity/topic that disagree.

Priority: highest. Contradictions are the most dangerous form of knowledge decay.

### 2. Dead links

Scan forward references (markdown links) in all files within scope. Check that each target path exists. Report broken links.

### 3. Stale claims

Find facts with dates older than 6 months that haven't been re-verified by a recent source. Look for date patterns (YYYY-MM-DD, "as of", "last checked") in knowledge files. Prioritize `type: snapshot` files — they're inherently time-sensitive and more likely to be stale than `type: topic` or `type: reference` files. Check `last_verified` frontmatter if present.

### 4. Orphan pages

Check LINKS.md for files within scope that have zero inbound references. These are candidates for connecting to the rest of the wiki or archiving.

Exclude: append-only files (inbox.md, journal.md, decisions.md, log.md), operational files (hot.md, LINKS.md).

### 5. Missing pages

Identify entities or concepts mentioned repeatedly across files (3+ mentions) but lacking their own dedicated page. Suggest creation with an appropriate type. Backed by `findCandidateEntities` which uses the entity registry to filter out already-promoted entities.

### 5b. Type suggestions

Check for files whose `type:` may be inaccurate based on content patterns:
- Files named after a person or place that are `type: topic` → suggest `type: entity`
- Files with point-in-time data that are `type: topic` → suggest `type: snapshot`
- Files that are inventories or lists that are `type: topic` → suggest `type: reference`

Present as suggestions, not issues — type refinement is optional.

### 6. Frontmatter gaps

Files missing `description:` frontmatter. These would break INDEX.md regeneration.

### 7. Data gaps

Based on existing knowledge patterns, suggest areas where information is thin. E.g., "You have 4 medical provider pages but no dentist page despite mentions of dental visits in journal."

### 8. Size warnings

Files approaching or exceeding `split_threshold_lines` (default 200). Report with current line counts.

## Output format

```markdown
## Lint Report — YYYY-MM-DD

### Issues (N)
1. **Contradiction** — <file-a> says X, but <file-b> says Y
2. **Dead link** — <file> links to <target> (file doesn't exist)
3. **Stale** — <file>: "<fact>" last verified YYYY-MM-DD (N months ago)
4. **Orphan** — <file>: zero inbound references
...

### Suggestions (N)
5. **Missing page** — "<entity>" mentioned in <file-a> (Nx) and <file-b> (Nx) but has no page
6. **Data gap** — <observation about thin coverage>
7. **Size warning** — <file>: N lines (threshold: 200)
```

## Issue cap

Default: 10 issues per lint run. Prioritized by severity:

1. Contradictions
2. Dead links
3. Stale claims
4. Orphans
5. Missing pages
6. Frontmatter gaps
7. Data gaps
8. Size warnings

Override with scope: `lint medical --limit 20` or `lint all --limit 50`.

## User interaction

Lint presents the report and waits. Robin does not auto-fix — contradictions and stale claims need human judgment. Robin can offer to help fix specific issues: "Want me to update the hemoglobin value and resolve the contradiction?"

## Graph exclusions

Skip files matching `robin.config.json` → `memory.graph_exclude` patterns. Default excludes: `knowledge/finance/lunch-money/transactions` (auto-generated data).

## Log

Append lint results summary to `user-data/memory/streams/log.md`:

```markdown
## [YYYY-MM-DD] lint | <scope> | issues: N
- Contradictions: N
- Dead links: N
- Stale claims: N
- Orphans: N
- Suggestions: N
```

## Boundary rule

Lint is read-only during the scan phase. It only writes when the user approves a fix. Lint can read any file under `user-data/memory/` and `user-data/memory/LINKS.md`.

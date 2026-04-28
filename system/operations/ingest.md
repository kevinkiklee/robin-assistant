---
name: ingest
triggers: ["ingest this", "ingest", "process this document", "add this to the wiki"]
description: Process a source document into the knowledge base — extract facts, ripple updates across knowledge files, log cross-references, and commit.
---
# Protocol: Ingest

Process a source document and integrate its knowledge across the memory tree. Creates a source summary page, updates related knowledge files, maintains cross-references, and commits the change for rollback safety.

## Trigger

User-initiated only. Never auto-triggered. The user must explicitly say "ingest this," reference a file/URL/text to process, or use a trigger phrase.

## Input types

| Type | Example | Acquisition |
|------|---------|-------------|
| **File** | "ingest this PDF" | If in `artifacts/input/`, move to `user-data/sources/`. If already in `sources/`, proceed. |
| **URL** | "ingest this article" + URL | Fetch content, save to `user-data/sources/articles/<slug>.md`, proceed. |
| **Inline** | "ingest this:" + pasted text | Save to `user-data/sources/notes/<slug>.md`, proceed. |

## Classification

Ingest is a **direct-write exception** per `system/capture-rules.md`. It writes directly to knowledge files, bypassing inbox. Rationale: ingest is user-supervised, multi-file, and too structural for inbox-first routing.

## Workflow

### 1. Dedup check

Search `user-data/memory/knowledge/sources/` for an existing source page with matching origin path, URL, or similar title. If found: warn, offer to re-ingest (update existing pages) or skip.

### 2. Read source

Read the source document fully. Apply privacy rules — reject content containing full SSNs, card numbers, credentials, etc.

### 3. Create source page

Write `user-data/memory/knowledge/sources/<slug>.md`:

```yaml
---
description: <one-line summary of the source>
type: source
ingested: YYYY-MM-DD
origin: <path relative to workspace root or URL>
tags: [<relevant-tags>]
---
```

Body: structured summary with key facts, entities mentioned, dates, and action items.

### 4. Extract

Identify from the source:
- Entities (people, places, organizations)
- Facts and data points
- Dates and deadlines
- Action items
- Contradictions with known information

### 5. Ripple

For each extracted item, update existing knowledge files:

1. Read `user-data/memory/INDEX.md` to find candidate files by description matching
2. Read full content of top 5-8 candidates to confirm relevance
3. Update confirmed matches inline with new information
4. Add cross-reference links to the source page
5. Append new edges to `user-data/memory/LINKS.md`

**New entity/concept check:** If an extracted entity or concept has no matching knowledge file, ask the user before creating one: "This mentions 'Dr. Chen' — should I create a new provider page?"

### 6. Contradiction handling

When new data contradicts existing knowledge:

1. Insert a blockquote in the affected knowledge file:
   ```
   > **Contradiction (YYYY-MM-DD):** Previous: <old value>. New source says: <new value>.
   > Source: [<source-title>](relative-path-to-source-page.md)
   ```
2. Log to `user-data/memory/log.md`
3. Surface to user during ingest — do not silently file

Per Rule: Precedence, the newer verified source data supersedes older data. Flag the contradiction for user review, then update the knowledge file with the new data.

### 7. Index rebuild

Ensure proper `description:` frontmatter on every new file created. Run `node system/scripts/regenerate-memory-index.js` to rebuild INDEX.md.

Skip if no new files were created (only existing files updated).

### 8. Log

Append to `user-data/memory/log.md`:

```markdown
## [YYYY-MM-DD] ingest | <source title> | touched: N files
- Created: <list of new files>
- Updated: <list of modified files>
- Cross-references added: N
- Contradictions found: N
```

### 9. Git commit

Commit all changed files with message: `ingest: <source title> — touched N files`

For batch ingest ("ingest all of these"), create one commit at the end: `ingest: batch of N sources — touched M files`

## What ingest does NOT do

- Auto-trigger — user must explicitly request it
- Modify the source file in `user-data/sources/`
- Create new knowledge files without asking (for entities Robin hasn't seen before)
- Bypass privacy rules
- Route through inbox — ingest is a direct-write exception

## Batch ingest

When user says "ingest all of these" or provides multiple sources:

1. Process each source through steps 1-6 sequentially
2. Run index rebuild once at the end (step 7)
3. Write one combined log entry (step 8)
4. Create one git commit for the batch (step 9)

## Boundary rule

Ingest can read and write any file under `user-data/memory/` and `user-data/sources/`. It can move files from `artifacts/input/` to `user-data/sources/`. It follows all lock protocols from `system/operations/multi-session-coordination.md` for pillar and mixed-use files.

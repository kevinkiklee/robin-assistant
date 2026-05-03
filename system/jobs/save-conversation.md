---
name: save-conversation
dispatch: subagent
model: opus
triggers: ["save this conversation", "file this session", "save conversation"]
description: File the key outcomes of the current conversation as a lightweight summary page in the knowledge base.
runtime: "agent"
enabled: false
timeout_minutes: 10
---
# Protocol: Save Conversation

Capture the key outcomes, decisions, and action items from the current conversation as a summary page. Distinct from query-to-wiki filing (which saves a specific analysis) — this saves the *conversation* as a whole.

## Trigger

User says "save this conversation," "file this session," or similar. Optional title: "save conversation: onboarding discussion".

## What gets created

A lightweight summary page at `user-data/memory/knowledge/conversations/<slug>.md`:

```yaml
---
description: <one-line summary of the conversation>
type: conversation
created: YYYY-MM-DD
tags: [<relevant-tags>]
---
```

Body structure:

```markdown
## <Conversation Title> — YYYY-MM-DD

**Duration:** ~N hours/minutes
**Topics:** <brief list of topics covered>

### Key Decisions
- <decision 1>
- <decision 2>

### Key Outcomes
- <outcome 1>
- <outcome 2>

### Action Items
- [ ] <action item 1>
- [ ] <action item 2>
```

## Rules

- **Cap at 50 lines.** These are summaries, not transcripts.
- **Don't duplicate inbox captures.** Conversation filing captures *outcomes and decisions as a whole*. Individual facts are already captured via the inbox pipeline.
- **Add cross-reference links** where the conversation touched existing knowledge files.
- **User provides title** or Robin infers one from the conversation topics.

## Post-filing

1. Append edges to `user-data/memory/LINKS.md` for any cross-references in the summary
2. Run `node system/scripts/memory/regenerate-index.js` to add the page to INDEX.md
3. Append to `user-data/memory/streams/log.md`: `## [YYYY-MM-DD] filed | <title> | type: conversation`

## Query-to-Wiki Filing

Separate from conversation filing. When Robin produces a substantive analysis (financial review, health comparison, project evaluation), the results can be filed as a richer knowledge page.

**Trigger:** User says "file this analysis," "save this to the wiki," "this is worth keeping." Or Robin suggests: "This analysis touches several knowledge areas. Want me to file it as a reference page?"

**What gets created:** A page in the appropriate knowledge subdirectory (not `conversations/`):

```yaml
---
description: <one-line summary>
type: analysis
created: YYYY-MM-DD
source: conversation
tags: [<relevant-tags>]
---
```

The body contains the cleaned-up analysis with source links to the knowledge files it drew from.

**Post-filing:** Same as conversation filing — LINKS.md update, INDEX rebuild, log entry.

## Lifecycle

Conversation pages older than 90 days with no inbound links in LINKS.md are flagged by Dream Phase 2 for archival or deletion. Conversations that have been cross-referenced by other knowledge files are retained — they've proven useful.

## Boundary rule

Save-conversation can write to `user-data/memory/knowledge/conversations/` and append to `user-data/memory/LINKS.md` and `user-data/memory/streams/log.md`. It triggers INDEX.md regeneration via script.

## Return schema (when dispatched as subagent)

```yaml
captured_facts: int
inbox_appended: bool
session_handoff_updated: bool
hot_md_updated: bool
notable: [string]
```

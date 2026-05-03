---
name: todo-extraction
dispatch: subagent
model: sonnet
triggers: ["extract todos from this", "todo extraction"]
description: Extract action items from a forwarded email, message, or document and add them to tasks.
runtime: "agent"
enabled: false
timeout_minutes: 15
---
# Protocol: Todo Extraction

## Triggers

- User forwards or pastes an email/message and says "extract todos", "what do I need to do from this", "add this to my todos"
- User shares a long thread and asks for action items

## Steps

1. Read the email/thread/document carefully.
2. Identify explicit asks ("can you", "please", "we need", "by [date]").
3. Identify implicit obligations (commitments user made, follow-ups owed).
4. For each, classify:
   - **Action item** -> add to appropriate section in `user-data/memory/tasks.md`
   - **FYI / context** -> note in `user-data/memory/streams/journal.md` if useful for future sessions
   - **Decision needed** -> create entry in `user-data/memory/streams/decisions.md`
5. Extract: task description, due date if mentioned, priority based on tone/sender.

## Output

List of extracted items with:
- What section of `user-data/memory/tasks.md` it goes into
- Proposed task wording
- Due date if any
- Priority

Confirm with user before adding, unless they said "just add them."

## After

Add confirmed items to the relevant files.

---
name: meeting-prep
triggers: ["prep for my meeting", "meeting prep"]
description: Prepare for an upcoming meeting by gathering context, attendees, prior history, and likely talking points.
runtime: "agent"
enabled: false
timeout_minutes: 15
---
# Protocol: Meeting Prep

## Triggers

"prep for my meeting", "prep for my event", "what's on my calendar at [time]", "help me prep for [event]"

## Steps

### 1. Get the event

Read `user-data/ops/config/integrations.md` for calendar status.
- If available: get the calendar event (subject, time, attendees, location, description).
- If not available: ask "What's the meeting? Give me the subject, time, attendees, and any context."

### 2. Search for related context

Read `user-data/ops/config/integrations.md` for email status.
- If email available: search for threads by subject keywords and attendee names (past 30 days).
- If not available: ask "Any recent email threads related to this meeting?"

Read `user-data/ops/config/integrations.md` for storage status.
- If storage available: search for documents by subject keywords and attendee names.
- If not available: skip this section.

### 3. Check workspace

Read `user-data/memory/knowledge.md` for any vendor/contact/topic matching the meeting subject.
Read `user-data/memory/streams/journal.md` and `user-data/memory/profile.md` for prior context.

## Output

- **Meeting:** subject, time, attendees, location
- **Context:** what this is about (1-2 sentences)
- **Recent threads:** key points from related email (if available)
- **Relevant docs:** document summaries (if available)
- **Prep questions:** what to think about beforehand
- **Suggested talking points:** if applicable

## After prep

Ask: "Anything specific you want to dig into before the meeting?"

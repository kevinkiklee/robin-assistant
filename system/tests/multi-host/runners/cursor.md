# Cursor — manual checklist

Cursor is IDE-bound; no clean headless mode. Run each scenario in a fresh
Cursor chat window with the project open. Record reads/writes into a
structured JSON file the validator can consume.

## Setup

1. Open the robin-assistant project in Cursor.
2. Open Cursor Settings → Models → confirm a frontier model is selected
   (Claude Opus 4.7, GPT-5.5, or Gemini Pro 3.1).
3. Ensure agent mode is on (chat alone won't trigger tool calls).

## Per-scenario procedure

For each of the 6 scenarios in `../scenarios/0N-*.md`:

1. Read the scenario file.
2. Run any setup commands listed.
3. Open a new Cursor chat (cmd-N).
4. Send the prompt.
5. After the agent finishes, write down every Read/Write/Edit tool call you
   saw, plus the assistant text response. Format as:

   ```json
   {
     "host": "cursor",
     "host_version": "<from Cursor → About>",
     "model": "<selected model>",
     "scenario": <n>,
     "reads": ["AGENTS.md", "user-data/memory/INDEX.md", "..."],
     "writes": ["user-data/memory/inbox.md"],
     "assistant": "<the assistant's response text>"
   }
   ```

   Save to `transcripts/cursor/<date>/0N-scenario.json`.

6. Run the validator:

   ```sh
   node system/scripts/validate-host.js \
     --host=cursor \
     --transcript=system/tests/multi-host/transcripts/cursor/<date>/0N-scenario.json \
     --scenario=N
   ```

7. Run any cleanup commands listed in the scenario.

## Tip

Cursor shows tool calls in a collapsible panel. Expand each one to see the
exact path; copy paths exactly (they're compared verbatim).

## Time

~5 minutes for all 6 scenarios.

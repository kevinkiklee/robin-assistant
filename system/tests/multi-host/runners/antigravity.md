# Antigravity — manual checklist

Antigravity (Google's agentic IDE) reads `AGENTS.md` natively as of v1.20.3
(March 2026). No headless mode for our purposes; run scenarios in the IDE.

## Setup

1. Open the robin-assistant project in Antigravity.
2. Confirm Gemini Pro 3.1 (or newer frontier model) is selected in the Agent
   panel.
3. Verify the workspace's `AGENTS.md` is being loaded (Agent → Context →
   should list AGENTS.md as a context source).

## Per-scenario procedure

For each of the 6 scenarios in `../scenarios/0N-*.md`:

1. Read the scenario file.
2. Run any setup commands in a terminal.
3. Open a new agent task in Antigravity.
4. Send the prompt.
5. After the agent finishes, capture reads/writes from the Agent panel's
   tool-call history. Format as:

   ```json
   {
     "host": "antigravity",
     "host_version": "<from Antigravity → About>",
     "model": "<selected model>",
     "scenario": <n>,
     "reads": ["AGENTS.md", "user-data/memory/INDEX.md", "..."],
     "writes": ["user-data/memory/streams/inbox.md"],
     "assistant": "<the assistant's response text>"
   }
   ```

   Save to `transcripts/antigravity/<date>/0N-scenario.json`.

6. Run the validator:

   ```sh
   node system/scripts/diagnostics/validate-host.js \
     --host=antigravity \
     --transcript=system/tests/multi-host/transcripts/antigravity/<date>/0N-scenario.json \
     --scenario=N
   ```

7. Run any cleanup commands.

## Antigravity-specific notes

- Antigravity may pre-fetch reference files (artifacts, browser history) that
  aren't agent-driven. Mark these as SOFT NOTE rather than fail.
- The Agent panel's tool history is collapsible per task; expand to see the
  full Read/Write log.

## Time

~5 minutes for all 6 scenarios.

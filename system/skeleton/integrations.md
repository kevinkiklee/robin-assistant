# Integrations

Platform: claude-code

## Available

- email: gmail
  - live: mcp__claude_ai_Gmail__         (Claude Code only)
- calendar: google
  - live: mcp__claude_ai_Google_Calendar__
- storage: google-drive
  - live: mcp__claude_ai_Google_Drive__
- finance: lunch-money
  - sync: knowledge/finance/lunch-money/  (daily, via sync-lunch-money job)
- weather: user-provided (paste or summarize)
- browser: user-provided (paste or summarize)

## Not configured

- maps, health

## Fallback behavior

For any integration not listed above, protocols ask the user to provide the
information directly (paste, summarize, or screenshot).

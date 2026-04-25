# Skill: Browser Automation

## Purpose
Use the right browser automation tool for the right task: claude-in-chrome (user's interactive browser), chrome-devtools (low-level inspection), or playwright (headless automation). Handle web tasks that aren't covered by Gmail/Calendar/Drive MCPs.

## User Context
User-specific browser context and common web tasks. Filled in over time as the assistant learns (e.g., which sites the user is frequently logged into, which tasks recur).

## Approach

### Pick the right tool

| Task | Use |
|---|---|
| Quick page inspection / read text from open tab | `mcp__claude-in-chrome__*` (interactive, user's session) |
| Check console errors / network requests on open tab | `mcp__chrome-devtools__*` (inspection) |
| Headless automation, no user presence needed | `mcp__plugin_playwright_playwright__*` |
| Take screenshot for visual review | claude-in-chrome `take_screenshot` |
| Page data user needs to review before any action | claude-in-chrome (so they see what I see) |
| Repeated automation (e.g., daily price check) | playwright (headless, scriptable) |

### Default: claude-in-chrome
For 80% of personal-assistant tasks, use `mcp__claude-in-chrome__*`. Reasons:
- User is logged into their accounts already
- They see what I do (transparency)
- No re-auth needed each session

### When to escalate to playwright
- Headless: user doesn't need to watch
- Recurring: same task multiple times
- Speed: many pages to scrape
- Multiple browsers / contexts in parallel

### When to use chrome-devtools
- Debugging a flaky page (console errors)
- Verifying network requests (e.g., what API does this site call?)
- Performance investigation (rare for PA work)

## Hard rules for browser work

### Rule: Verify before submitting
**Before clicking any submit/confirm/delete/send button:**
1. Take a screenshot
2. Show the user what I'm about to do
3. Wait for explicit "go" unless the action is clearly reversible

This is a specific application of `Rule: Ask vs Act` for the browser context.

### Rule: Don't trigger native dialogs
JavaScript alerts/confirms/prompts block the browser session. Avoid clicking buttons that trigger them. If unavoidable, warn the user first.

### Rule: Sensitive data masking
When taking screenshots or extracting page text from financial/medical/account pages, redact account numbers (last 4 only), SSN, full balances if not needed. Per `Rule: Privacy`.

### Rule: One tab at a time
Don't spawn multiple browser tabs unless the task explicitly requires it.

## Common patterns

### Pattern: Read auth-gated info (e.g., bank balance, health portal)
1. Tell the user: "I'll check [site]. Go ahead and log in if not already; I'll wait."
2. Navigate to the URL using an existing tab or `tabs_create_mcp`
3. `get_page_text` or `take_snapshot`
4. Extract relevant info, mask sensitive parts
5. Update memory/knowledge file with the data point + date
6. Close the tab if created for this task

### Pattern: Fill a form
1. Navigate to the form
2. Use `find` to locate fields by label/role (more robust than CSS selectors)
3. `form_input` to fill values
4. Show screenshot before submit
5. Wait for the user's "go"
6. Submit, capture confirmation

### Pattern: Scrape comparison data (e.g., price check)
1. Use playwright (headless) for speed and parallelism
2. Define URL list + extraction selectors
3. Run, log results to a memory file or knowledge entry
4. Schedule via cron if recurring

### Pattern: Research a topic
1. Try WebSearch first (faster, no auth)
2. If a specific page needs extraction, use claude-in-chrome with user's context
3. Summarize and link source URLs in the output

### Pattern: Capture a screenshot of user's existing tab
For situations where the user says "look at this page on my screen":
1. `tabs_context_mcp` — get list of open tabs
2. `select_page` to focus on the right one (don't create new)
3. `take_screenshot` and analyze

## What NOT to use browser automation for

- Tasks already covered by Gmail/Calendar/Drive MCPs (faster, structured)
- Tasks where the site has an API + community MCP (use the MCP)
- Anything the user can do faster manually
- Bulk actions on accounts (high blast radius — use APIs with proper auth instead)

## Key Concepts
- **Selector resilience:** prefer text/role over CSS class — sites change classes constantly
- **Wait conditions:** modern web apps load async; use `wait_for` instead of fixed sleeps
- **Authentication state:** claude-in-chrome shares the user's logged-in state (cookies). Playwright by default does NOT — needs separate auth setup
- **Headless vs headed:** headless is faster but sometimes detected as bot; switch to headed if blocked

## Checklist
- [ ] Can this be done with Gmail/Calendar/Drive/WebSearch instead?
- [ ] If yes, use the simpler tool
- [ ] If no, pick the right browser tool (table above)
- [ ] If task involves submit/confirm/delete: screenshot + ask first
- [ ] If task involves sensitive data: plan masking before extraction

## User Preferences
<!-- Filled in over time -->

## Revision Log
### 2026-04-25 — Initial creation
Generalized from source workspace. Established patterns for the three browser automation MCPs (claude-in-chrome, chrome-devtools, playwright). Default to claude-in-chrome for interactive PA tasks; playwright for headless scripting; chrome-devtools for debugging.

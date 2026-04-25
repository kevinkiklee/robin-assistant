# Integrations Guide

How to document, install, and track MCP integrations for arc-assistant. Each integration extends what the assistant can do — authenticated API access, live data, and external services.

---

## How to add an integration

1. Install the MCP server (see per-integration instructions below)
2. Add it to your Claude Code config (`settings.json` under `mcpServers`)
3. Update `arc.config.json` `integrations` section to mark it as live
4. Test with a simple prompt that exercises the new tools
5. Update this file: move from "pending" to "live" and record the tool name pattern

If you run multiple Claude Code configs, add the MCP to each config to keep them in sync.

---

## Integration tiers

### Tier 1: Real new capability
Integrations that unlock data the assistant cannot access any other way.

### Tier 2: Friction reduction
Integrations that make existing workflows faster but aren't strictly required.

---

## Common integrations

### Weather / environment
**Purpose:** Current conditions, forecasts, air quality for planning and briefings.
**Options:**
- Google Environment (custom MCP wrapping Google Weather + Air Quality APIs) — requires Google Maps API key
- OpenWeatherMap MCP — free tier API key, global coverage
**Tool patterns:** `weather_current`, `weather_forecast_daily`, `weather_forecast_hourly`, `air_quality_current`

### Maps / location
**Purpose:** Directions, travel time, place lookup, distance matrix.
**Options:**
- `@modelcontextprotocol/server-google-maps` (official Anthropic MCP) — requires Google Maps API key
**Setup:** Enable Geocoding, Places, Directions, Distance Matrix APIs in Google Cloud Console.
**Tool pattern:** `mcp__google-maps__*`

### Health / wearables
**Purpose:** Recovery scores, sleep data, HRV, strain for morning briefings and health correlations.
**Options:**
- Whoop MCP — [JedPattersonn/whoop-mcp](https://github.com/JedPattersonn/whoop-mcp) or [nissand/whoop-mcp-server-claude](https://github.com/nissand/whoop-mcp-server-claude)
  - Setup: register OAuth client at developer.whoop.com, configure, authorize
- Garmin / Apple Health: community MCPs vary; check mcpservers.org

### Health records
**Purpose:** Lab results, appointments, prescriptions — without screenshots.
**Options:**
- SMART-on-FHIR MCP — [jmandel/health-record-mcp](https://mcpservers.org/servers/jmandel/health-record-mcp)
  - Works with Epic-based health systems. Requires app registration with your health system.
  - Alternative: Apple Health export → XML parse (no auth required but manual)

### Personal finance
**Purpose:** Real-time balances, transactions, subscription detection, budget tracking.
**Options:**
- Plaid (community MCPs — NOT Plaid's official developer MCP which is for Plaid integrations, not personal finance):
  - [driggsby.com](https://driggsby.com/) — managed, connects via Plaid Link
  - [t-rhex/plaid-mcp](https://glama.ai/mcp/servers/t-rhex/plaid-mcp) — self-hosted, local token storage
- Security note: Plaid stores OAuth tokens. Review each option's security posture before connecting bank accounts.

### Messaging / Apple ecosystem
**Purpose:** SMS context, Notes, Reminders, Contacts lookup — native app access.
**Options:**
- [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp) — Notes, Messages, Contacts, Reminders, Calendar, Maps, Mail in one install
  - macOS-only. Requires System Settings → Privacy & Security → Automation permissions.
- [carterlasalle/mac_messages_mcp](https://github.com/carterlasalle/mac_messages_mcp) — messages only

### Browser automation
See `core/skills/browser-automation.md` for the full decision tree.
- `mcp__claude-in-chrome__*` — interactive, user's active browser session
- `mcp__chrome-devtools__*` — inspection and debugging
- `mcp__plugin_playwright_playwright__*` — headless automation

---

## Already available (no install needed)

Most arc-assistant deployments include these out of the box via Claude Code:
- Gmail (`mcp__claude_ai_Gmail__*`)
- Google Calendar (`mcp__claude_ai_Google_Calendar__*`)
- Google Drive (`mcp__claude_ai_Google_Drive__*`)
- WebSearch / WebFetch
- Context7 (library docs)

These are deferred tools. First use each session: call `ToolSearch` with `select:<tool_name>` to load the schema before calling.

---

## Tracking integration status

In `arc.config.json`, the `integrations` key tracks live vs pending:

```json
{
  "integrations": {
    "google-maps": { "status": "live", "toolPattern": "mcp__google-maps__*" },
    "weather": { "status": "pending" },
    "whoop": { "status": "pending" },
    "plaid": { "status": "pending" }
  }
}
```

Update this after installing and testing each integration. The assistant reads this at session start to know what tools are available.

---

## After installing an integration

1. Update `arc.config.json` integrations section
2. Test the new tools with a simple prompt
3. Review which protocols and skills use this type of data — update them to leverage the new tool
4. Update `CLAUDE.md` External Tools section with the new tool pattern

const START_MARKER = '<!-- robin-mcp:start -->';
const END_MARKER = '<!-- robin-mcp:end -->';

const SECURITY_START = '<!-- robin-security:start (auto-generated, do not hand-edit) -->';
const SECURITY_END = '<!-- robin-security:end -->';

export function buildSecurityBlock() {
  return `${SECURITY_START}
## Security posture

- **Storage:** local SurrealDB at \`<package_root>/user-data/db/\`, **no encryption at rest**. RocksDB has no built-in encryption layer; rely on filesystem-level encryption (FileVault, LUKS) for confidentiality. Treat this directory as containing the user's full personal context.
- **Secrets:** \`<package_root>/user-data/secrets/.env\` (mode 0600). Read on demand; never persisted to \`process.env\`. Avoid logging secret-bearing variables; the outbound-policy's secret-scanner runs against tool inputs, not arbitrary log output.
- **Outbound writes:** PII / secret / verbatim-untrusted-quote guards via \`outbound/policy.js\`. Per-tool rate-limited (default 10/hr).
- **Trust model:** integration data carries \`trust='untrusted'\`. Recall surfaces it but do not quote untrusted content into outbound writes verbatim within the last 7 days.
${SECURITY_END}
`;
}

function formatCadence(ms, kind) {
  if (kind === 'gateway') return 'gateway';
  if (kind === 'tool-only') return 'tool-only';
  if (ms === null || ms === undefined) return 'gateway';
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

function renderIntegrationsList(integrations) {
  const lines = [];
  for (const i of integrations) {
    const cadence = formatCadence(i.cadence_ms, i.kind);
    const hasTools = (i.tool_names ?? []).length > 0;
    const tools = hasTools ? i.tool_names.join(', ') : '(no agent-callable tools)';
    if (i.kind === 'gateway') {
      lines.push(
        `- ${i.name} (gateway): bot listens on allowlist; ${hasTools ? tools : 'no agent-callable tools'}`,
      );
    } else if (i.kind === 'tool-only') {
      lines.push(`- ${i.name} (tool-only): ${tools}`);
    } else if (i.cadence_ms === null || i.cadence_ms === undefined) {
      // Back-compat: old-shape input without kind, null cadence → gateway-style line.
      lines.push(`- ${i.name} (${cadence}): bot listens on allowlist; no agent-callable tools`);
    } else if (!hasTools) {
      lines.push(`- ${i.name} (${cadence}): no agent-callable tools`);
    } else {
      lines.push(`- ${i.name} (${cadence}): ${tools}`);
    }
  }
  if (lines.length === 0) lines.push('- (none registered)');
  return lines.join('\n');
}

export function integrationsSection(integrations = []) {
  return `<!-- robin-integrations:start (auto-generated, do not hand-edit) -->
## Integration data freshness

Before quoting integration data as "today's" / "current" / "latest", call
integration_status({name}) and verify last_sync_at is within 2× the cadence.
If stale, either label the quote as "data from <last_sync_at>" OR call
integration_run({name}) to refresh.

After integration_run, the result IS immediate when no concurrent sync is
running — the tool awaits and returns count/cursor/duration_ms. If it returns
{ ok: false, reason: 'in_flight' }, poll integration_status({name}) every 2s
(don't poll faster); when in_flight flips to false, check last_sync_at and
last_sync_ok. Don't loop more than ~30 polls (~60s).

Don't fabricate fresh data. Don't loop on integration_run — the 30s
min-interval will refuse, and repeated polling burns API quota.

## Outbound writes (github_write, spotify_write, discord_send)

Use \`github_write\` for create-issue / comment / label / mark-read; use
\`spotify_write\` for queue / skip / playlist-add; use \`discord_send\` for
send_dm / send_channel. All three go through:

1. Per-tool rate limit (default 10/hr; refuses with
   { ok: false, reason: 'rate_limited', wait_seconds: N } — wait at least
   \`wait_seconds\` before retrying).
2. Outbound-policy: text content (create-issue body, comment body, playlist
   name/description, message content) is checked for PII / secret /
   verbatim-untrusted-quote leakage. If blocked, the tool returns
   { ok: false, reason: 'outbound_blocked', blocked_by: '<policy reason>' };
   DON'T retry by paraphrasing to bypass the guard — surface the block to
   the user and ask for guidance.
3. The actual API call.

\`discord_send\` adds a 4th gate before the API call: the recipient (DM
\`user_id\` or channel's \`guild_id\`) must be in the configured allowlist;
otherwise { ok: false, reason: 'not_allowed' }. Content is capped at 2000
chars; over-cap returns { ok: false, reason: 'content_too_long' }.

Audit trail differs by action:
- create-issue, comment, playlist-add, send_dm, send_channel → captured to
  events (recall searchable).
- label, mark-read, queue, skip → daemon log only (no text content).
  Don't expect recall('issue I labeled X') to find anything.

## Available integrations

${renderIntegrationsList(integrations)}
<!-- robin-integrations:end -->`;
}

export function agentsMdContent({ integrations = [] } = {}) {
  return `# Robin

You're talking to a user through Robin. Robin gives you a memory layer
through MCP tools. Use it.

## Memory tools

When the user asks "what do I know about X", "have I mentioned Y before",
"who/what is Z", or any question that requires recalling past conversations,
documents, or notes, call \`recall(query=...)\`. Don't guess from training data;
recall.

When you learn something noteworthy about the user, their projects, their
people, or their preferences — call \`remember(content=...)\`. Be discerning;
not every utterance is worth remembering. Good candidates: explicit
preferences, named projects/people first introduced, decisions, deadlines.

When you need to find a specific person/place/project/topic mentioned before,
call \`find_entity(name=...)\`. Use \`related_entities(id=...)\` to explore who
or what is connected to that entity. Use \`get_entity(id=...)\` for details
about one specific entity.

When the user asks "what was I doing yesterday/last week", call
\`list_episodes(since=...)\`.

## When to call run_biographer

You normally don't need to. Robin runs biographer automatically after each
of your responses. Call \`run_biographer\` only when the user explicitly asks
"process my pending memories" or after \`remember\` if the user wants
immediate effect.

## Feedback (helps Robin learn)

After you use results from \`recall(...)\` to answer a question, call
\`mark_recall_used(recall_event_id=..., used_hit_ids=[...])\` with the IDs
of the hits that informed your answer. Hits that didn't help shouldn't be
in \`used_hit_ids\` — that's a negative signal Robin uses to improve.

When the user corrects you — "no, that's wrong", "I actually prefer X",
"the answer is Y not Z" — call \`record_correction(content=..., prior_response=...)\`.
Be specific in \`content\`: "user prefers concise answers over detailed ones",
not just "user disagreed."

## Active rules (read at session start)

At the start of each conversation, call \`list_rules({status: 'active'})\` once and
fold the returned rules into how you respond. These are user preferences and
corrections the user has previously approved. Apply them silently; don't recite
them back.

## Pending rule candidates

Robin's dream agent periodically surfaces "rule candidates" — patterns from
recent user corrections that might warrant a permanent rule. When you have
opportunity (natural breakpoint, after a correction, or when user asks about
their preferences), call \`list_rules({status: 'pending'})\` and surface
candidates conversationally:

  "I noticed you've corrected me three times about verbosity in the last week.
   Want me to remember 'prefer concise answers'?"

If user says yes → \`update_rule(id, 'approve')\`.
If user says no → \`update_rule(id, 'reject', { reason: '...' })\`.
Don't badger; once per session at most for any given candidate.

## Profile updates as candidates

Profile changes (name, pronouns, timezone, interests) come through the same
\`rule_candidates\` flow with kind='profile_update'. Same approve/reject pattern.
Approval applies the field changes to the user's profile.

## Daemon health

\`health()\` reports daemon status — useful for debugging if memory tools
are misbehaving.

## Tone

Speak with the warmth and concision of a thoughtful friend who knows you
well. Don't be servile. Don't summarize your own actions ("I'll now call
recall..."). Just do the work and answer.

${integrationsSection(integrations)}

${buildSecurityBlock()}
`;
}

export function mergeAgentsMdContent(existingFile, newRobinSection) {
  const fencedSection = `${START_MARKER}\n${newRobinSection.trimEnd()}\n${END_MARKER}\n`;
  if (existingFile.includes(START_MARKER) && existingFile.includes(END_MARKER)) {
    const before = existingFile.slice(0, existingFile.indexOf(START_MARKER));
    const afterIdx = existingFile.indexOf(END_MARKER) + END_MARKER.length;
    let after = existingFile.slice(afterIdx);
    if (after.startsWith('\n')) after = after.slice(1);
    return `${before}${fencedSection}${after}`;
  }
  const sep = existingFile.length === 0 || existingFile.endsWith('\n') ? '' : '\n';
  return `${existingFile}${sep}${fencedSection}`;
}

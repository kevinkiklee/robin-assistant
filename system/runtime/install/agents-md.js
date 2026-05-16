import { DAY_MS, HOUR_MS, MINUTE_MS } from '../../config/time.js';

const START_MARKER = '<!-- robin-mcp:start -->';
const END_MARKER = '<!-- robin-mcp:end -->';

const SECURITY_START = '<!-- robin-security:start (auto-generated, do not hand-edit) -->';
const SECURITY_END = '<!-- robin-security:end -->';

export function buildSecurityBlock() {
  return `${SECURITY_START}
## Security posture

- **Storage:** local SurrealDB at \`<package_root>/user-data/data/db/\`, **no encryption at rest**. RocksDB has no built-in encryption layer; rely on filesystem-level encryption (FileVault, LUKS) for confidentiality. Treat this directory as containing the user's full personal context.
- **Secrets:** \`<package_root>/user-data/config/secrets/.env\` (mode 0600). Read on demand; never persisted to \`process.env\`. Avoid logging secret-bearing variables; the outbound-policy's secret-scanner runs against tool inputs, not arbitrary log output.
- **Outbound writes:** PII / secret / verbatim-untrusted-quote guards via \`outbound/policy.js\`. Per-tool rate-limited (default 10/hr).
- **Trust model:** integration data carries \`trust='untrusted'\`. Recall surfaces it but do not quote untrusted content into outbound writes verbatim within the last 7 days.
${SECURITY_END}
`;
}

function formatCadence(ms, kind) {
  if (kind === 'gateway') return 'gateway';
  if (kind === 'tool-only') return 'tool-only';
  if (ms === null || ms === undefined) return 'gateway';
  if (ms >= DAY_MS && ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${ms / MINUTE_MS}m`;
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

function renderJobsList(jobs) {
  if (!Array.isArray(jobs)) return '(jobs surface unavailable — daemon not initialized)';
  if (jobs.length === 0) return '(no jobs registered)';
  return jobs
    .map((j) => {
      const status = j.enabled ? 'enabled' : 'disabled';
      const next = j.next_run_at ? new Date(j.next_run_at).toISOString() : '—';
      return `- ${j.name.padEnd(20)} ${status.padEnd(9)} ${(j.schedule ?? '').padEnd(16)} next=${next}`;
    })
    .join('\n');
}

function jobsSection(jobs) {
  return `<!-- robin-jobs:start (auto-generated, do not hand-edit) -->
## Background jobs

Robin runs scheduled jobs inside the daemon (heartbeat scheduler). You CAN
call \`run_job({ name })\` to trigger one on the user's behalf, but SHOULD
only do so on explicit user request. Scheduled fires happen
autonomously; don't try to drive them.

Jobs declared with \`manually_runnable: false\` (destructive maintenance,
backups, etc.) refuse \`run_job\` regardless of who calls.

### Known jobs

${renderJobsList(jobs)}
<!-- robin-jobs:end -->`;
}

function actionsSection() {
  return `<!-- robin-actions:start (auto-generated, do not hand-edit) -->
## Action policy (AUTO / ASK / NEVER)

Outbound tools (\`discord_send\`, \`github_write\`, \`spotify_write\`, and
future writes) have a per-action trust state. Each (tool, action) is its
own class — e.g. \`discord_send:send_dm\`, \`github_write:create-issue\`.

- **AUTO** — proceed without asking.
- **ASK** — the tool refuses with \`{ ok: false, reason: 'requires_permission', class }\`.
  Surface this to the user. If the user authorizes, retry with
  \`{ ...args, force: true }\` THIS TURN ONLY. Don't auto-force; the user has
  to actually say yes.
- **NEVER** — the tool refuses regardless of \`force\`. To resume use,
  the user must run \`robin actions set <class> ASK\` (or you can call
  \`update_action_policy({class, state: 'ASK'})\` on their explicit behalf).

Default for any new (tool, action) class is **ASK**. State auto-demotes
AUTO → ASK when you call \`record_correction({tool, action, ...})\` —
one correction is enough.

When the user gives **standing** permission ("you can always queue songs
for me"), call \`update_action_policy({class: 'spotify_write:queue', state: 'AUTO'})\`.
When they revoke ("don't ever do that again"), set state to 'NEVER'.

Use \`check_action({tool, action})\` to peek the state before planning
a multi-step action.
<!-- robin-actions:end -->`;
}

function gitHygieneSection() {
  return `<!-- robin-git-hygiene:start (auto-generated, do not hand-edit) -->
## Multi-agent git hygiene

Robin is designed for concurrent agent sessions (see \`.claude/worktrees/\`).
Git's lock file serializes individual commands but does NOT compose across
two commands, so the standard \`git add\` → \`git commit\` pattern has a race
window where another session's \`git commit -am …\` can sweep your staged
files into their commit under their message.

**Rules:**

- **Never use \`-a\` or \`-am\`** in commit commands. These widen scope to all
  modified tracked files, including files staged by other sessions.
- **Prefer \`git commit -m "msg" -- file1 file2 file3\`** — a single atomic
  command that stages and commits the explicit file list in one operation.
- If a two-step \`git add\` → \`git commit\` is unavoidable, run
  \`git diff --cached --name-only\` immediately before the commit AND
  \`git show HEAD --stat\` immediately after. If the post-commit diff is
  wider than expected, do not push — resolve before any further commits.
- When unsure whether files are yours, scope to a worktree via
  \`git -C <worktree-path>\`.
<!-- robin-git-hygiene:end -->`;
}

function knowledgeOpsSection() {
  return `<!-- robin-knowledge-ops:start (auto-generated, do not hand-edit) -->
## Knowledge ops

Three tools for memory hygiene. ALL are user-triggered — never autonomous,
never called on a loop.

- \`ingest({content|url|file_path})\` — write a source document into
  events + entities + edges + knowledge in one shot. Call only when the
  user says "ingest this", "add this to memory", "process this document",
  or pastes a file/URL.
- \`lint({limit})\` — read-only mechanical sweep (orphans, dead edges,
  duplicates, near-dupes, stale). Cheap, no LLM calls. Call when the user
  says "check memory", "memory health", "lint memory".
- \`audit({pair_count})\` — read-only LLM scan for contradictions across
  recent knowledge. ~8 LLM calls per invocation (balanced tier). Call when
  the user says "audit memory" — never on a loop.
<!-- robin-knowledge-ops:end -->`;
}

function integrationsSection(integrations = []) {
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

function stripLeadingH1(body) {
  return body.replace(/^#\s+[^\n]*\n+/, '');
}

function shiftHeadingsDown(body) {
  return body
    .split('\n')
    .map((line) => (/^#{2,5}\s/.test(line) ? `#${line}` : line))
    .join('\n');
}

function commStyleSection(commStyle) {
  let scalarBlock;
  if (commStyle?.tone) {
    const ts = commStyle.last_synthesized_at
      ? new Date(commStyle.last_synthesized_at).toISOString()
      : 'unknown';
    scalarBlock = `## Communication style

Inferred preferences (synthesized nightly from your corrections):
{
  tone: "${commStyle.tone}",
  formality: "${commStyle.formality}",
  emoji_ok: ${commStyle.emoji_ok},
  direct_feedback_ok: ${commStyle.direct_feedback_ok},
  code_comment_density: "${commStyle.code_comment_density}",
  summary_style: "${commStyle.summary_style}",
  confidence: ${commStyle.confidence},
  synthesized: ${ts}
}

If \`confidence\` is low (<0.4), treat these as soft hints; honor explicit
instructions in the current turn first. Use \`get_comm_style()\` to re-read
if something might have updated mid-session.`;
  } else {
    scalarBlock = `## Communication style

No comm-style inferred yet — too few corrections, or Dream hasn't run.
Use balanced defaults. Use \`get_comm_style()\` once a session has produced
corrections to check whether enough signal has accumulated.`;
  }

  const longForm = [];
  const rules = commStyle?.['communication-style'];
  const character = commStyle?.character;
  const personality = commStyle?.personality;

  if (typeof rules === 'string' && rules.trim()) {
    longForm.push(
      `### Active rules (long form)\n\n${shiftHeadingsDown(stripLeadingH1(rules)).trim()}`,
    );
  }
  if (typeof character === 'string' && character.trim()) {
    longForm.push(
      `### Character — integrative read\n\n${shiftHeadingsDown(stripLeadingH1(character)).trim()}`,
    );
  }
  if (typeof personality === 'string' && personality.trim()) {
    longForm.push(
      `### Robin's personality\n\n${shiftHeadingsDown(stripLeadingH1(personality)).trim()}`,
    );
  }

  const body = [scalarBlock, ...longForm].join('\n\n');

  return `<!-- robin-comm-style:start (auto-generated, do not hand-edit) -->
${body}
<!-- robin-comm-style:end -->`;
}

export function calibrationSection(calibration) {
  if (calibration?.by_kind && Object.keys(calibration.by_kind).length > 0) {
    const lines = Object.entries(calibration.by_kind).map(([k, v]) => {
      const pct = (v.accuracy * 100).toFixed(0);
      return `- ${k}: ${pct}% accurate (n=${v.resolved})`;
    });
    const ts = calibration.last_computed_at
      ? new Date(calibration.last_computed_at).toISOString()
      : 'unknown';
    return `<!-- robin-calibration:start (auto-generated, do not hand-edit) -->
## Calibration

Your past predictions (synthesized nightly):
${lines.join('\n')}
- total_open: ${calibration.total_open ?? 0} predictions awaiting resolution
- last_computed: ${ts}

When you make a falsifiable claim — "this will take 30 min", "you usually prefer X",
"the meeting is at 3pm" — call \`predict({statement, kind, confidence})\` so
calibration can improve. When the outcome becomes known, call
\`resolve_prediction({id, correct, actual_outcome})\`. You can call
\`list_open_predictions()\` to find unresolved claims.

If accuracy < 50% for a kind, treat new predictions in that kind with
low confidence (≤ 0.5).
<!-- robin-calibration:end -->`;
  }
  return `<!-- robin-calibration:start (auto-generated, do not hand-edit) -->
## Calibration

No calibration data yet — make some predictions and resolve them. Call
\`predict({statement, kind, confidence})\` when you make a falsifiable
claim, then \`resolve_prediction({id, correct, ...})\` when you find out.
Common kinds: \`duration\`, \`fact_recall\`, \`preference_guess\`,
\`identity\`, \`event_timing\`.
<!-- robin-calibration:end -->`;
}

export function agentsMdContent({ integrations = [], jobs, commStyle, calibration } = {}) {
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

Robin learns from recalls automatically: every \`recall(...)\` logs a row that
the reinforcement evaluator checks 5 minutes later. If no correction landed
in the meantime, hits get reinforced; if one did, the recall is marked
corrected. You don't need to mark hits manually.

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

${jobsSection(jobs)}

${gitHygieneSection()}

${knowledgeOpsSection()}

${actionsSection()}

${commStyleSection(commStyle)}

${calibrationSection(calibration)}

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

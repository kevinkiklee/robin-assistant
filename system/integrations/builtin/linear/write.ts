import type { IntegrationContext } from '../../_runtime/types.ts';
import { gql, type LinearIssue } from './gql.ts';
import { addCommentedRef, hasCommentedRef, isSatisfied, lookupByRef, upsertMap } from './map.ts';

/* ---------- GraphQL ---------- */

const ISSUE_CREATE = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url state { name type } team { key name } }
  }
}`;

const ISSUE_UPDATE = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier title url state { name type } team { key name } }
  }
}`;

const COMMENT_CREATE = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body }
  }
}`;

const ISSUE_SEARCH = `
query SearchIssue($q: String!) {
  issueSearch(query: $q, first: 1) {
    nodes {
      id identifier title description url
      state { name type }
      team { key name }
      updatedAt
    }
  }
}`;

const TEAM_STATES = `
query TeamStates($teamId: String!) {
  team(id: $teamId) {
    states { nodes { id name type } }
  }
}`;

const TEAM_LABELS = `
query TeamLabels($teamId: String!) {
  team(id: $teamId) {
    labels { nodes { id name } }
  }
}`;

const LABEL_CREATE = `
mutation LabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

/* ---------- helpers ---------- */

interface CachedTeam {
  id: string;
  key: string;
  name: string;
}

function getCachedTeams(ctx: IntegrationContext): CachedTeam[] {
  const raw = ctx.state.get('cached_teams');
  if (!raw) return [];
  return JSON.parse(raw) as CachedTeam[];
}

function resolveTeamId(ctx: IntegrationContext, teamKey: string): string {
  const teams = getCachedTeams(ctx);
  const team = teams.find((t) => t.key.toLowerCase() === teamKey.toLowerCase());
  if (!team)
    throw new Error(
      `team '${teamKey}' not found in cached teams (have: ${teams.map((t) => t.key).join(', ') || 'none'})`,
    );
  return team.id;
}

interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

async function resolveStateId(
  ctx: IntegrationContext,
  teamId: string,
  intentType: string,
): Promise<string> {
  const cacheKey = `team_states:${teamId}`;
  let states: WorkflowState[];
  const cached = ctx.state.get(cacheKey);
  if (cached) {
    states = JSON.parse(cached) as WorkflowState[];
  } else {
    type R = { team: { states: { nodes: WorkflowState[] } } };
    const data = await gql<R>(ctx, TEAM_STATES, { teamId });
    states = data.team.states.nodes;
    ctx.state.set(cacheKey, JSON.stringify(states));
  }
  const match = states.find((s) => s.type === intentType);
  if (!match)
    throw new Error(
      `no state with type '${intentType}' for team ${teamId} (have: ${states.map((s) => `${s.name}[${s.type}]`).join(', ')})`,
    );
  return match.id;
}

async function ensureRobinLabel(ctx: IntegrationContext, teamId: string): Promise<string> {
  const cacheKey = `robin_label:${teamId}`;
  const cached = ctx.state.get(cacheKey);
  if (cached) return cached;

  type LabelsR = { team: { labels: { nodes: Array<{ id: string; name: string }> } } };
  const data = await gql<LabelsR>(ctx, TEAM_LABELS, { teamId });
  const existing = data.team.labels.nodes.find((l) => l.name.toLowerCase() === 'robin');
  if (existing) {
    ctx.state.set(cacheKey, existing.id);
    return existing.id;
  }

  type CreateR = {
    issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } };
  };
  const created = await gql<CreateR>(ctx, LABEL_CREATE, {
    input: { name: 'robin', teamId },
  });
  if (!created.issueLabelCreate.success) throw new Error('failed to create robin label');
  ctx.state.set(cacheKey, created.issueLabelCreate.issueLabel.id);
  return created.issueLabelCreate.issueLabel.id;
}

async function resolveIssueId(
  ctx: IntegrationContext,
  ref: string,
): Promise<{ issueId: string; identifier: string; teamKey: string }> {
  // Try map first (robin_ref lookup)
  const mapRow = lookupByRef(ctx.db, ref);
  if (mapRow) {
    return {
      issueId: mapRow.linear_issue_id,
      identifier: mapRow.identifier ?? ref,
      teamKey: '',
    };
  }

  // Try issueSearch (identifier like ENG-123)
  type R = { issueSearch: { nodes: LinearIssue[] } };
  const data = await gql<R>(ctx, ISSUE_SEARCH, { q: ref });
  const issue =
    data.issueSearch.nodes.find((i) => i.identifier === ref) ?? data.issueSearch.nodes[0];
  if (!issue) throw new Error(`issue not found for ref '${ref}'`);
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    teamKey: issue.team.key,
  };
}

/* ---------- write actions ---------- */

interface CreateIssueParams {
  team: string;
  title: string;
  description?: string;
  robin_ref?: string;
  project_id?: string;
  priority?: number;
  source_event_id?: number;
}

async function createIssue(
  params: CreateIssueParams,
  ctx: IntegrationContext,
): Promise<{ created: boolean; issue?: LinearIssue; skipped_reason?: string }> {
  // Idempotency: if robin_ref is provided and already satisfied, skip
  if (params.robin_ref) {
    if (isSatisfied(ctx.db, params.robin_ref)) {
      return {
        created: false,
        skipped_reason: 'robin_ref already satisfied (completed/cancelled)',
      };
    }
    const existing = lookupByRef(ctx.db, params.robin_ref);
    if (existing) {
      return {
        created: false,
        skipped_reason: `robin_ref already mapped to ${existing.identifier ?? existing.linear_issue_id}`,
      };
    }
  }

  const teamId = resolveTeamId(ctx, params.team);
  const labelId = await ensureRobinLabel(ctx, teamId);

  const input: Record<string, unknown> = {
    teamId,
    title: params.title,
    labelIds: [labelId],
  };
  if (params.description) input.description = params.description;
  if (params.project_id) input.projectId = params.project_id;
  if (params.priority !== undefined) input.priority = params.priority;

  type R = { issueCreate: { success: boolean; issue: LinearIssue } };
  const data = await gql<R>(ctx, ISSUE_CREATE, { input });
  if (!data.issueCreate.success) throw new Error('issueCreate returned success=false');
  const issue = data.issueCreate.issue;

  if (params.robin_ref) {
    upsertMap(ctx.db, {
      robin_ref: params.robin_ref,
      linear_issue_id: issue.id,
      identifier: issue.identifier,
      team_id: teamId,
      last_state_type: issue.state.type,
      source_event_id: params.source_event_id,
      last_action: 'create',
    });
  }

  await ctx.ingest({
    kind: 'linear.write',
    source: 'linear',
    content: `Created [${issue.identifier}] ${issue.title}`,
    payload: {
      action: 'create_issue',
      identifier: issue.identifier,
      robin_ref: params.robin_ref,
      url: issue.url,
    },
  });

  return { created: true, issue };
}

interface UpdateIssueParams {
  ref: string;
  title?: string;
  description?: string;
  priority?: number;
}

async function updateIssue(
  params: UpdateIssueParams,
  ctx: IntegrationContext,
): Promise<{ updated: boolean; issue?: LinearIssue }> {
  const { issueId, identifier } = await resolveIssueId(ctx, params.ref);

  const input: Record<string, unknown> = {};
  if (params.title !== undefined) input.title = params.title;
  if (params.description !== undefined) input.description = params.description;
  if (params.priority !== undefined) input.priority = params.priority;

  if (Object.keys(input).length === 0) {
    return { updated: false };
  }

  type R = { issueUpdate: { success: boolean; issue: LinearIssue } };
  const data = await gql<R>(ctx, ISSUE_UPDATE, { id: issueId, input });
  if (!data.issueUpdate.success) throw new Error('issueUpdate returned success=false');

  await ctx.ingest({
    kind: 'linear.write',
    source: 'linear',
    content: `Updated [${identifier}] ${Object.keys(input).join(', ')}`,
    payload: {
      action: 'update_issue',
      identifier,
      ref: params.ref,
      fields: Object.keys(input),
    },
  });

  return { updated: true, issue: data.issueUpdate.issue };
}

interface TransitionParams {
  ref: string;
  intent: string;
}

async function transition(
  params: TransitionParams,
  ctx: IntegrationContext,
): Promise<{ transitioned: boolean; issue?: LinearIssue }> {
  const { issueId, identifier } = await resolveIssueId(ctx, params.ref);

  // Need team ID to look up states. Try map row first, then resolve from issueSearch result.
  const mapRow = lookupByRef(ctx.db, params.ref);
  let teamId: string;
  if (mapRow?.team_id) {
    teamId = mapRow.team_id;
  } else {
    // Re-fetch the issue to get team info
    type R = { issueSearch: { nodes: LinearIssue[] } };
    const data = await gql<R>(ctx, ISSUE_SEARCH, { q: identifier });
    const issue =
      data.issueSearch.nodes.find((i) => i.identifier === identifier) ?? data.issueSearch.nodes[0];
    if (!issue) throw new Error(`cannot resolve team for '${params.ref}'`);
    teamId = resolveTeamId(ctx, issue.team.key);
  }

  const stateId = await resolveStateId(ctx, teamId, params.intent);

  type R = { issueUpdate: { success: boolean; issue: LinearIssue } };
  const data = await gql<R>(ctx, ISSUE_UPDATE, { id: issueId, input: { stateId } });
  if (!data.issueUpdate.success) throw new Error('transition issueUpdate returned success=false');
  const issue = data.issueUpdate.issue;

  // Update map if we have a robin_ref
  if (mapRow) {
    upsertMap(ctx.db, {
      robin_ref: mapRow.robin_ref,
      linear_issue_id: issueId,
      last_state_type: params.intent,
      last_action: 'transition',
    });
  }

  await ctx.ingest({
    kind: 'linear.write',
    source: 'linear',
    content: `Transitioned [${identifier}] to ${params.intent}`,
    payload: {
      action: 'transition',
      identifier,
      ref: params.ref,
      intent: params.intent,
    },
  });

  return { transitioned: true, issue };
}

interface CommentParams {
  ref: string;
  body: string;
  robin_ref?: string;
}

async function comment(
  params: CommentParams,
  ctx: IntegrationContext,
): Promise<{ commented: boolean; skipped_reason?: string }> {
  const { issueId, identifier } = await resolveIssueId(ctx, params.ref);

  // Comment-level idempotency via robin_ref on the issue's map row
  if (params.robin_ref) {
    // Find the issue's map row (by the issue ref, not the comment ref)
    const mapRow = lookupByRef(ctx.db, params.ref);
    if (mapRow && hasCommentedRef(ctx.db, params.ref, params.robin_ref)) {
      return {
        commented: false,
        skipped_reason: `comment robin_ref '${params.robin_ref}' already posted`,
      };
    }
  }

  type R = { commentCreate: { success: boolean; comment: { id: string; body: string } } };
  const data = await gql<R>(ctx, COMMENT_CREATE, {
    input: { issueId, body: params.body },
  });
  if (!data.commentCreate.success) throw new Error('commentCreate returned success=false');

  // Track the comment ref if provided
  if (params.robin_ref) {
    const mapRow = lookupByRef(ctx.db, params.ref);
    if (mapRow) {
      addCommentedRef(ctx.db, params.ref, params.robin_ref);
    }
  }

  await ctx.ingest({
    kind: 'linear.write',
    source: 'linear',
    content: `Commented on [${identifier}]`,
    payload: {
      action: 'comment',
      identifier,
      ref: params.ref,
      comment_robin_ref: params.robin_ref,
    },
  });

  return { commented: true };
}

/* ---------- bundled export ---------- */

export const writeActions = {
  create_issue: createIssue,
  update_issue: updateIssue,
  transition,
  comment,
};

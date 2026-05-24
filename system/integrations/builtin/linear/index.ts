import { ingest } from '../../../brain/memory/ingest.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';
import { gql, requireKey, type LinearIssue } from './gql.ts';

const ACTIVE_QUERY = `
query ActiveIssues($limit: Int!) {
  viewer {
    assignedIssues(filter: { state: { type: { in: ["unstarted", "started"] } } }, first: $limit, orderBy: updatedAt) {
      nodes {
        id identifier title description url
        state { name type }
        team { key name }
        updatedAt
      }
    }
  }
}`;

const ISSUE_SEARCH_QUERY = `
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

export const integration: Integration = {
  async tick(ctx) {
    try {
      requireKey();
    } catch (err) {
      return { status: 'skipped', message: err instanceof Error ? err.message : String(err) };
    }

    type ActiveResult = { viewer: { assignedIssues: { nodes: LinearIssue[] } } };
    const data = await gql<ActiveResult>(ctx, ACTIVE_QUERY, { limit: 30 });
    const issues = data.viewer.assignedIssues.nodes;

    let ingested = 0;
    const seen = new Set(JSON.parse(ctx.state.get('seen_issue_ids') ?? '[]'));
    for (const issue of issues) {
      const key = `${issue.id}:${issue.updatedAt}`; // dedupe by id+updatedAt so updates are reingested
      if (seen.has(key)) continue;
      seen.add(key);
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.linear.issue',
        source: 'linear',
        content: `[${issue.identifier}] ${issue.title} (${issue.state.name}, team ${issue.team.key})${issue.description ? `\n\n${issue.description.slice(0, 500)}` : ''}`,
        payload: {
          identifier: issue.identifier,
          state: issue.state.name,
          team: issue.team.key,
          url: issue.url,
          updatedAt: issue.updatedAt,
        },
      });
      ingested++;
    }
    const seenArr = Array.from(seen).slice(-300);
    ctx.state.set('seen_issue_ids', JSON.stringify(seenArr));
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    if (!process.env.LINEAR_API_KEY) return { ok: false, message: 'LINEAR_API_KEY not set' };
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

export const actions = {
  async active_issues(params: { limit?: number }, ctx: IntegrationContext): Promise<LinearIssue[]> {
    type Result = { viewer: { assignedIssues: { nodes: LinearIssue[] } } };
    const data = await gql<Result>(ctx, ACTIVE_QUERY, { limit: params.limit ?? 20 });
    return data.viewer.assignedIssues.nodes;
  },
  async get_issue(
    params: { identifier: string },
    ctx: IntegrationContext,
  ): Promise<LinearIssue | null> {
    type Result = { issueSearch: { nodes: LinearIssue[] } };
    const data = await gql<Result>(ctx, ISSUE_SEARCH_QUERY, { q: params.identifier });
    return (
      data.issueSearch.nodes.find((i) => i.identifier === params.identifier) ??
      data.issueSearch.nodes[0] ??
      null
    );
  },
};

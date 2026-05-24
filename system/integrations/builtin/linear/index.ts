import type { Integration, IntegrationContext } from '../../_runtime/types.ts';
import { gql, type LinearIssue, requireKey } from './gql.ts';
import { openMappedIssueIds, refreshStateTypes } from './map.ts';

const ASSIGNED_ISSUES_QUERY = `
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

const TEAM_ISSUES_QUERY = `
query TeamIssues($updatedAfter: DateTimeOrDuration!, $limit: Int!, $after: String) {
  viewer {
    teamMemberships {
      nodes {
        team { id key name }
      }
    }
  }
  issues(
    filter: {
      state: { type: { in: ["unstarted", "started", "backlog"] } }
      updatedAt: { gte: $updatedAfter }
    }
    first: $limit
    after: $after
    orderBy: updatedAt
  ) {
    nodes {
      id identifier title description url
      state { name type }
      team { key name }
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUES_BY_IDS_QUERY = `
query IssuesByIds($ids: [String!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id identifier
      state { name type }
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

    const windowDays = 14;
    const updatedAfter = new Date(Date.now() - windowDays * 86400000).toISOString();
    const cap = 200;

    type TeamIssuesResult = {
      viewer: {
        teamMemberships: { nodes: Array<{ team: { id: string; key: string; name: string } }> };
      };
      issues: {
        nodes: LinearIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };

    let ingested = 0;
    const seen = new Set(JSON.parse(ctx.state.get('seen_issue_ids') ?? '[]'));
    let after: string | undefined;
    let totalFetched = 0;

    while (totalFetched < cap) {
      const pageSize = Math.min(50, cap - totalFetched);
      const data = await gql<TeamIssuesResult>(ctx, TEAM_ISSUES_QUERY, {
        updatedAfter,
        limit: pageSize,
        after: after ?? null,
      });

      // Cache team memberships for write actions (id resolution)
      if (!after) {
        const teams = data.viewer.teamMemberships.nodes.map((m) => m.team);
        ctx.state.set('cached_teams', JSON.stringify(teams));
      }

      for (const issue of data.issues.nodes) {
        totalFetched++;
        const key = `${issue.id}:${issue.updatedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await ctx.ingest({
          kind: 'integration.linear.issue',
          source: 'linear',
          content: `[${issue.identifier}] ${issue.title} (${issue.state.name}, team ${issue.team.key})${issue.description ? `\n\n${issue.description.slice(0, 500)}` : ''}`,
          payload: {
            identifier: issue.identifier,
            state: issue.state.name,
            state_type: issue.state.type,
            team: issue.team.key,
            url: issue.url,
            updatedAt: issue.updatedAt,
          },
        });
        ingested++;
      }

      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor ?? undefined;
    }

    // Reconciliation: refresh state types for open mapped issues
    try {
      const openIds = openMappedIssueIds(ctx.db);
      if (openIds.length > 0) {
        for (let i = 0; i < openIds.length; i += 50) {
          const batch = openIds.slice(i, i + 50);
          type NodesResult = {
            nodes: Array<{
              id: string;
              identifier: string;
              state: { name: string; type: string };
            } | null>;
          };
          const data = await gql<NodesResult>(ctx, ISSUES_BY_IDS_QUERY, { ids: batch });
          const updates = data.nodes
            .filter((n): n is NonNullable<typeof n> => n !== null && 'state' in n)
            .map((n) => ({ linear_issue_id: n.id, state_type: n.state.type }));
          if (updates.length > 0) refreshStateTypes(ctx.db, updates);
        }
      }
    } catch {
      // Reconciliation is best-effort; don't fail the tick
    }

    const seenArr = Array.from(seen).slice(-500);
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
    const data = await gql<Result>(ctx, ASSIGNED_ISSUES_QUERY, { limit: params.limit ?? 20 });
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

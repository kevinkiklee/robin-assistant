import { readJsonArrayState } from '../../_runtime/state-helpers.ts';
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
      # Include terminal states (completed/canceled) so a close is CAPTURED, not
      # inferred from absence. Without this, an issue that transitions to Done
      # simply stops matching the filter and the last open snapshot lingers for
      # the full window — the brief then shows closed issues as open (KL-10,
      # 2026-05-29). Consumers dedupe by identifier (newest wins) and drop
      # terminal states themselves.
      state: { type: { in: ["unstarted", "started", "backlog", "completed", "canceled"] } }
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

// Linear's API hard-rejects the old issueSearch field as deprecated; issue(id:)
// accepts the human identifier ("KL-19") directly, so no search is needed.
const ISSUE_BY_IDENTIFIER_QUERY = `
query IssueByIdentifier($q: String!) {
  issue(id: $q) {
    id identifier title description url
    state { name type }
    team { key name }
    updatedAt
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
    // Dedup cache is self-managed state; corruption is handled in readJsonArrayState
    // (warn + reset to empty) so a bad value never wedges the tick.
    const seen = new Set(readJsonArrayState<string>(ctx, 'seen_issue_ids'));
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
    type Result = { issue: LinearIssue | null };
    const data = await gql<Result>(ctx, ISSUE_BY_IDENTIFIER_QUERY, { q: params.identifier });
    return data.issue;
  },
};

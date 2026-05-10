// Linear GraphQL client. PAT auth — `Authorization: <api_key>` (no Bearer).

const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `
  id identifier title priority
  state { name type }
  assignee { name email }
  team { id key name }
  project { id name }
  cycle { id number name }
  url updatedAt dueDate
`;

export async function graphql({
  apiKey,
  query,
  variables = {},
  fetchFn = globalThis.fetch,
  signal,
}) {
  const r = await fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`linear graphql failed: ${r.status} ${body.slice(0, 200)}`);
  }
  const data = await r.json();
  if (data.errors) throw new Error(`linear graphql: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// Pull active issues updated since `updatedAfter`. Pagination cap: 200 issues
// across 4 pages of 50 (Linear's max page size is 50).
export async function listActiveIssues({
  apiKey,
  updatedAfter = null,
  teamKeys = [],
  cap = 200,
  fetchFn,
  signal,
}) {
  const filter = {};
  if (updatedAfter) filter.updatedAt = { gte: updatedAfter };
  if (teamKeys.length > 0) filter.team = { key: { in: teamKeys } };
  // Only active issues: state.type not in completed/canceled.
  filter.state = { type: { nin: ['completed', 'canceled'] } };

  const out = [];
  let after = null;
  for (let page = 0; page < Math.ceil(cap / 50); page++) {
    const data = await graphql({
      apiKey,
      query: `
        query($filter: IssueFilter, $after: String) {
          issues(first: 50, after: $after, filter: $filter, orderBy: updatedAt) {
            pageInfo { hasNextPage endCursor }
            nodes { ${ISSUE_FIELDS} }
          }
        }
      `,
      variables: { filter, after },
      fetchFn,
      signal,
    });
    const issues = data.issues;
    if (!issues) break;
    out.push(...issues.nodes);
    if (!issues.pageInfo.hasNextPage) break;
    after = issues.pageInfo.endCursor;
  }
  return out.slice(0, cap);
}

export function buildEventFromIssue(issue) {
  const identifier = issue.identifier ?? issue.id;
  const stateName = issue.state?.name ?? 'unknown';
  const priorityLabel = priorityLabelFor(issue.priority);
  const title = issue.title ?? '(untitled)';
  return {
    source: 'linear',
    content: `${stateName} · ${priorityLabel} · ${title}`,
    ts: issue.updatedAt ? new Date(issue.updatedAt) : new Date(),
    external_id: `linear:${identifier}`,
    meta: {
      issue_id: issue.id ?? null,
      identifier,
      title,
      state: stateName,
      state_type: issue.state?.type ?? null,
      priority: priorityLabel,
      priority_value: typeof issue.priority === 'number' ? issue.priority : null,
      assignee: issue.assignee?.name ?? null,
      team: issue.team?.key ?? null,
      team_name: issue.team?.name ?? null,
      project: issue.project?.name ?? null,
      cycle: issue.cycle?.number != null ? `Cycle ${issue.cycle.number}` : null,
      url: issue.url ?? null,
      updated_at: issue.updatedAt ?? null,
      due_date: issue.dueDate ?? null,
    },
  };
}

function priorityLabelFor(p) {
  // Linear: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low.
  switch (p) {
    case 1:
      return 'Urgent';
    case 2:
      return 'High';
    case 3:
      return 'Medium';
    case 4:
      return 'Low';
    default:
      return 'No priority';
  }
}

export { priorityLabelFor };

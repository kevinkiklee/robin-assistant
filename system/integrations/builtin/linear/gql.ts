import type { IntegrationContext } from '../../_runtime/types.ts';

export const ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string; type: string };
  team: { key: string; name: string };
  updatedAt: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearState {
  id: string;
  name: string;
  type: string;
}

export function requireKey(): string {
  const k = process.env.LINEAR_API_KEY;
  if (!k) throw new Error('LINEAR_API_KEY not set in environment');
  return k;
}

export async function gql<T>(
  ctx: Pick<IntegrationContext, 'fetch'>,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const key = requireKey();
  const res = await ctx.fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`linear graphql returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length)
    throw new Error(`linear graphql errors: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error('linear graphql returned no data');
  return body.data;
}

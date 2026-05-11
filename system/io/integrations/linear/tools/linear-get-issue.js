import { requireSecret } from '../../../secrets/dotenv-io.js';
import { graphql } from '../client.js';

const ISSUE_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id identifier title description priority
      state { name type }
      assignee { name email }
      team { id key name }
      project { id name }
      cycle { id number name }
      labels { nodes { name } }
      url createdAt updatedAt completedAt dueDate
    }
  }
`;

export function createLinearGetIssueTool() {
  return {
    name: 'linear_get_issue',
    description: 'Fetch a Linear issue live by identifier (e.g. ENG-123). Reads from Linear API.',
    inputSchema: {
      type: 'object',
      properties: { identifier: { type: 'string' } },
      required: ['identifier'],
    },
    handler: async (args) => {
      try {
        const apiKey = requireSecret('LINEAR_API_KEY');
        const data = await graphql({
          apiKey,
          query: ISSUE_QUERY,
          variables: { id: args.identifier },
        });
        return { issue: data?.issue ?? null };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error('linear not configured; set LINEAR_API_KEY in robin secrets');
        }
        throw e;
      }
    },
  };
}

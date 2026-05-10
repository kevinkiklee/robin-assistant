import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getGoogleAccessToken } from '../../_auth/token-cache.js';
import { listMessages } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createGmailSearchTool() {
  return {
    name: 'gmail_search',
    description: 'Search Gmail using Gmail query syntax. Returns message stubs (id, threadId).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
        const page = await listMessages({ accessToken, q: args.query });
        return { messages: (page.messages ?? []).slice(0, args.max ?? 20) };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error(
            'gmail not authenticated; run: robin secrets import --from <v1-user-data>',
          );
        }
        throw e;
      }
    },
  };
}

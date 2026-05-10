import { requireSecret } from '../../../secrets/dotenv-io.js';
import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { listMessages } from '../client.js';

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
      let secrets;
      try {
        secrets = {
          GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
          GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
          GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
        };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error(
            'gmail not authenticated; run: robin secrets import --from <v1-user-data>',
          );
        }
        throw e;
      }
      const fresh = await ensureFreshToken(secrets);
      const page = await listMessages({ accessToken: fresh.access_token, q: args.query });
      return { messages: (page.messages ?? []).slice(0, args.max ?? 20) };
    },
  };
}

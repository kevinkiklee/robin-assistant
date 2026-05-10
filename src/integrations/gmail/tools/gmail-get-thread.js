import { requireSecret } from '../../../secrets/dotenv-io.js';
import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { getThread } from '../client.js';

export function createGmailGetThreadTool() {
  return {
    name: 'gmail_get_thread',
    description: 'Fetch a Gmail thread by ID; returns full message bodies.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
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
      const thread = await getThread({
        accessToken: fresh.access_token,
        threadId: args.thread_id,
      });
      return { thread };
    },
  };
}

import { requireSecret, saveSecret } from '../../../secrets/dotenv-io.js';
import { getAccessToken } from '../../_auth/token-cache.js';
import { getThread } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

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
      try {
        const accessToken = await getAccessToken({
          provider: 'google',
          secrets: buildSecrets(),
          saveSecret,
        });
        const thread = await getThread({ accessToken, threadId: args.thread_id });
        return { thread };
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

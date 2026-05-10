import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getGoogleAccessToken } from '../../_auth/google-token-cache.js';
import { listFiles } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createDriveSearchTool() {
  return {
    name: 'drive_search',
    description: 'Search Google Drive files by name (live API).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
        const q = `name contains '${args.query.replace(/'/g, "\\'")}'`;
        const page = await listFiles({ accessToken, q });
        return { files: (page.files ?? []).slice(0, args.limit ?? 20) };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error(
            'Google not authenticated; run: robin secrets import --from <v1-user-data>',
          );
        }
        throw e;
      }
    },
  };
}

import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getGoogleAccessToken } from '../../_auth/token-cache.js';
import { getEvent } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createCalendarGetEventTool() {
  return {
    name: 'calendar_get_event',
    description: 'Fetch a Google Calendar event live (current state, not stale snapshot).',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
    handler: async (args) => {
      try {
        const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
        const event = await getEvent({ accessToken, eventId: args.event_id });
        return { event };
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

import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { readSecrets } from '../../_auth/secrets-io.js';
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
      const secrets = await readSecrets('gmail');
      if (!secrets) throw new Error('gmail not authenticated; run: robin auth gmail');
      const fresh = await ensureFreshToken('gmail', secrets);
      const thread = await getThread({
        accessToken: fresh.access_token,
        threadId: args.thread_id,
      });
      return { thread };
    },
  };
}

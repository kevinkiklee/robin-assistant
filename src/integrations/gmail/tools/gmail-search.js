import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { readSecrets } from '../../_auth/secrets-io.js';
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
      const secrets = await readSecrets('gmail');
      if (!secrets) throw new Error('gmail not authenticated; run: robin auth gmail');
      const fresh = await ensureFreshToken('gmail', secrets);
      const page = await listMessages({ accessToken: fresh.access_token, q: args.query });
      return { messages: (page.messages ?? []).slice(0, args.max ?? 20) };
    },
  };
}

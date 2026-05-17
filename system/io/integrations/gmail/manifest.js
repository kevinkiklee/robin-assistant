import { sync } from './sync.js';
import { createGmailGetThreadTool } from './tools/gmail-get-thread.js';
import { createGmailMailPreviewTool } from './tools/gmail-mail-preview.js';
import { createGmailSearchTool } from './tools/gmail-search.js';
import { createGmailShipmentsTool } from './tools/gmail-shipments.js';
import { createGmailSubscriptionsTool } from './tools/gmail-subscriptions.js';

export const manifest = {
  name: 'gmail',
  cadence: '15m',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: [
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ],
  },
  sync,
  tools: [
    createGmailSearchTool,
    createGmailGetThreadTool,
    createGmailShipmentsTool,
    createGmailSubscriptionsTool,
    createGmailMailPreviewTool,
  ],
};

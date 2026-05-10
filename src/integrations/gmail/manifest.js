import { sync } from './sync.js';
import { createGmailGetThreadTool } from './tools/gmail-get-thread.js';
import { createGmailSearchTool } from './tools/gmail-search.js';

export const manifest = {
  name: 'gmail',
  cadence: '15m',
  embed: true,
  capture_mode: 'insert-or-skip',
  auth: {
    kind: 'oauth2-google',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  sync,
  tools: [createGmailSearchTool, createGmailGetThreadTool],
};

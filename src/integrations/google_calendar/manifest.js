import { sync } from './sync.js';
import { createCalendarGetEventTool } from './tools/calendar-get-event.js';
import { createCalendarListEventsTool } from './tools/calendar-list-events.js';

export const manifest = {
  name: 'google_calendar',
  cadence: '30m',
  embed: true,
  capture_mode: 'upsert',
  secrets: {
    env_keys: [
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ],
  },
  sync,
  tools: [createCalendarListEventsTool, createCalendarGetEventTool],
};

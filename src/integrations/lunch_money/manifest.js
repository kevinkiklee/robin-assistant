import { sync } from './sync.js';
import { createLunchMoneyQueryTool } from './tools/lunch-money-query.js';

export const manifest = {
  name: 'lunch_money',
  cadence: '1d',
  embed: true,
  capture_mode: 'upsert',
  auth: { kind: 'api-key' },
  sync,
  tools: [createLunchMoneyQueryTool],
};

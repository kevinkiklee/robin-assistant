import { sync } from './sync.js';
import { createLunchMoneyQueryTool } from './tools/lunch-money-query.js';

export const manifest = {
  name: 'lunch_money',
  cadence: '1d',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: ['LUNCH_MONEY_API_KEY'] },
  sync,
  tools: [createLunchMoneyQueryTool],
};

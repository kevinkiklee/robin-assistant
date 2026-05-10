import { start } from './start.js';
import { stop } from './stop.js';

export const manifest = {
  name: 'discord',
  cadence: null,
  embed: false,
  capture_mode: 'insert-or-skip',
  auth: { kind: 'discord-bot' },
  start,
  stop,
  tools: [],
};

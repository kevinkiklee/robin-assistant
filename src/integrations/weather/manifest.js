import { sync } from './sync.js';
import { createWeatherTodayTool } from './tools/weather-today.js';

export const manifest = {
  name: 'weather',
  cadence: '6h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  sync,
  tools: [createWeatherTodayTool],
};

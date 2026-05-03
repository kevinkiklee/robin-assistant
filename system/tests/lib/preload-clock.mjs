import { installClock } from './clock.js';

if (process.env.ROBIN_CLOCK) installClock(process.env.ROBIN_CLOCK);

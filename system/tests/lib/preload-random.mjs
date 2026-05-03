import { installRandom } from './ids.js';

if (process.env.ROBIN_RANDOM_SEED) installRandom(process.env.ROBIN_RANDOM_SEED);

// reinforce-recall.js — internal-runtime job for the recall reinforcement loop.
// Spec §6.4. Schedule: */5 * * * * (every 5 minutes).
//
// Walks recall_log rows whose outcome='pending' and ts < now - 5min; checks
// for correction events in the session window; reinforces or marks corrected.

import { evaluatePending } from '../../recall/reinforcement.js';

export default async function reinforceRecall({ db }) {
  const summary = await evaluatePending(db);
  return `evaluated=${summary.evaluated} reinforced=${summary.reinforced} corrected=${summary.corrected} no_signal=${summary.no_signal}`;
}

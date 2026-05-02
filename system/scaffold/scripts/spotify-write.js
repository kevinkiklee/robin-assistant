#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// Spotify write CLI. Single entry point dispatched on --action.
//
// Usage examples:
//   node user-data/scripts/spotify-write.js --action queue \
//     --json '{"track_uri":"spotify:track:11dFghVXANMlKmJXsNCbNl"}'
//
//   node user-data/scripts/spotify-write.js --action playlist-add \
//     --json '{"playlist_id":"37i9dQZF...","track_uris":["spotify:track:..."]}'
//
//   node user-data/scripts/spotify-write.js --action skip --json '{}'
//
// Per AGENTS.md `Rule: Ask vs Act`, the agent confirms with the user before
// invoking writes that affect playback or playlists.

import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../../system/scripts/sync/lib/oauth.js';
import { SpotifyClient } from './lib/spotify/client.js';
import { assertOutboundContentAllowed, OutboundPolicyError, buildRefusalEntry } from '../../system/scripts/lib/outbound-policy.js';
import { appendPolicyRefusal } from '../../system/scripts/lib/policy-refusals-log.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--action') out.action = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const HANDLERS = {
  queue: async (client, payload) => {
    if (!payload.track_uri) throw new Error('queue: track_uri is required');
    await client.addToQueue(payload.track_uri);
    return { queued: payload.track_uri };
  },
  skip: async (client) => {
    await client.skipNext();
    return { skipped: true };
  },
  'playlist-add': async (client, payload) => {
    if (!payload.playlist_id) throw new Error('playlist-add: playlist_id is required');
    if (!Array.isArray(payload.track_uris) || payload.track_uris.length === 0) {
      throw new Error('playlist-add: track_uris (non-empty array) is required');
    }
    return client.addTracksToPlaylist(payload.playlist_id, payload.track_uris);
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) {
    console.error(`Usage: spotify-write.js --action <queue|skip|playlist-add> --json '{...}'`);
    process.exit(2);
  }
  if (!HANDLERS[args.action]) {
    console.error(`Unknown action: ${args.action}. Known: ${Object.keys(HANDLERS).join(', ')}`);
    process.exit(2);
  }
  if (!args.json) {
    console.error('Missing --json payload');
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(args.json);
  } catch (err) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(`[spotify-write] DRY-RUN action=${args.action} payload=${JSON.stringify(payload)}`);
    return;
  }

  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const accessToken = await getAccessToken(workspaceDir, 'spotify');
  const client = new SpotifyClient(accessToken);

  // Outbound policy gate (cycle-1b). Spotify writes are user-bound by OAuth;
  // taint + sensitive-shape checks still run on payload content.
  const checkContent = JSON.stringify(payload);
  const target = 'spotify:user:' + (args.action || 'unknown');
  try {
    assertOutboundContentAllowed({
      content: checkContent,
      target,
      workspaceDir,
    });
  } catch (e) {
    if (e instanceof OutboundPolicyError) {
      appendPolicyRefusal(workspaceDir, buildRefusalEntry({ target, error: e, content: checkContent }));
      process.stderr.write(`OUTBOUND_REFUSED [${e.layer}]: ${e.reason}\n`);
      process.exit(11);
    }
    throw e;
  }

  const result = await HANDLERS[args.action](client, payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`[spotify-write] failed: ${err.message}`);
  process.exit(1);
});

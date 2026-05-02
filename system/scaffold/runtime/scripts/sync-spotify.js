#!/usr/bin/env node
// Template — auto-copied to user-data/runtime/scripts/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// Spotify sync — pulls recently-played (append-only), top tracks/artists
// (regenerated), and playlist snapshots. Lazy-caches audio-features per track.
//
// Usage:
//   node user-data/runtime/scripts/sync-spotify.js
//   node user-data/runtime/scripts/sync-spotify.js --bootstrap
//   node user-data/runtime/scripts/sync-spotify.js --dry-run

import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getAccessToken } from '../../../system/scripts/sync/lib/oauth.js';
import { loadCursor, saveCursor } from '../../../system/scripts/sync/lib/cursor.js';
import { atomicWrite, writeTable, openItem } from '../../../system/scripts/sync/lib/markdown.js';
import { updateIndex } from '../../../system/scripts/sync/lib/index-updater.js';
import { acquireLock, releaseLock } from '../../../system/scripts/jobs/lib/atomic.js';
import { buildEntityRegistry } from '../../../system/scripts/wiki-graph/lib/build-entity-registry.js';
import { applyEntityLinks } from '../../../system/scripts/wiki-graph/lib/apply-entity-links.js';
import { SpotifyClient } from './lib/spotify/client.js';

const SOURCE = 'sync-spotify';
const PROVIDER = 'spotify';

function nowISO() { return new Date().toISOString(); }

// Insert wiki-graph entity links into a memory file we just wrote.
// Best-effort; never throw to the caller.
async function linkAfterWrite(workspaceDir, registry, wsRelPath) {
  if (!registry || !wsRelPath.startsWith('user-data/memory/')) return;
  const memRelPath = wsRelPath.slice('user-data/memory/'.length);
  try {
    await applyEntityLinks(workspaceDir, memRelPath, registry);
  } catch (err) {
    console.warn(`sync-spotify: applyEntityLinks(${memRelPath}) failed: ${err.message}`);
  }
}

function trackToRow(item) {
  const t = item.track;
  return {
    played_at: item.played_at?.slice(0, 19).replace('T', ' ') ?? '',
    track: t?.name ?? '',
    artist: (t?.artists ?? []).map((a) => a.name).join(', '),
    album: t?.album?.name ?? '',
    duration_ms: String(t?.duration_ms ?? ''),
    track_id: t?.id ?? '',
  };
}

function topTrackRow(t) {
  return {
    track: t.name ?? '',
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    popularity: String(t.popularity ?? ''),
    duration_ms: String(t.duration_ms ?? ''),
    track_id: t.id ?? '',
  };
}

function topArtistRow(a) {
  return {
    artist: a.name ?? '',
    genres: (a.genres ?? []).join(', '),
    followers: String(a.followers?.total ?? ''),
    popularity: String(a.popularity ?? ''),
    artist_id: a.id ?? '',
  };
}

// Append-only recently-played: read existing rows, dedup by played_at, append new.
function mergeRecentlyPlayed(existingMd, newRows) {
  const existing = new Set();
  if (existingMd) {
    for (const line of existingMd.split('\n')) {
      const m = line.match(/^\| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) /);
      if (m) existing.add(m[1]);
    }
  }
  const fresh = newRows.filter((r) => !existing.has(r.played_at));
  return fresh;
}

export async function syncSpotify({ workspaceDir, dryRun = false, bootstrap = false }) {
  let registry = null;
  try {
    registry = await buildEntityRegistry(workspaceDir);
  } catch (err) {
    console.warn(`sync-spotify: registry unavailable, skipping link insertion (${err.message})`);
  }

  const accessToken = await getAccessToken(workspaceDir, PROVIDER);
  const client = new SpotifyClient(accessToken);

  const me = await client.me();
  console.log(`[sync-spotify] account: ${me.display_name ?? me.id}`);

  const cursor = loadCursor(workspaceDir, SOURCE);
  const lastPlayedAt = cursor.cursor?.last_played_at ?? null;

  // 1. Recently played (append-only).
  const rp = await client.recentlyPlayed({ limit: 50 });
  const items = rp.items ?? [];
  const newRows = items.map(trackToRow).sort((a, b) => a.played_at.localeCompare(b.played_at));
  console.log(`[sync-spotify] ${items.length} recently-played tracks (Spotify caps at 50)`);

  // Gap detection: if oldest returned is newer than our cursor's last_played_at,
  // we missed plays.
  let gapDetected = false;
  if (lastPlayedAt && items.length === 50) {
    const oldestReturned = newRows[0]?.played_at;
    if (oldestReturned && oldestReturned > lastPlayedAt) gapDetected = true;
  }

  // 2. Top items (4w / 6m / all-time)
  const [t4w, t6m, tAll] = await Promise.all([
    client.topItems('tracks', { time_range: 'short_term', limit: 50 }),
    client.topItems('tracks', { time_range: 'medium_term', limit: 50 }),
    client.topItems('tracks', { time_range: 'long_term', limit: 50 }),
  ]);
  const [a4w, a6m, aAll] = await Promise.all([
    client.topItems('artists', { time_range: 'short_term', limit: 50 }),
    client.topItems('artists', { time_range: 'medium_term', limit: 50 }),
    client.topItems('artists', { time_range: 'long_term', limit: 50 }),
  ]);

  // 3. Playlists (just metadata; tracks fetched lazily for diffing)
  const playlists = bootstrap ? await client.myPlaylists({ cap: 100 }) : [];
  console.log(`[sync-spotify] top tracks/artists in 3 windows; ${playlists.length} playlists`);

  if (dryRun) {
    console.log('[sync-spotify] dry-run: skipping writes');
    return { recently_played: items.length, top_tracks: t4w.items?.length, playlists: playlists.length };
  }

  // Write recently-played (append).
  const rpPath = 'user-data/memory/knowledge/spotify/recently-played.md';
  const rpFull = join(workspaceDir, rpPath);
  const existing = existsSync(rpFull) ? readFileSync(rpFull, 'utf-8') : '';
  const fresh = mergeRecentlyPlayed(existing, newRows);
  let combinedTable;
  if (existing && existing.includes('|---|')) {
    // Append to existing table — extract trailing rows + insert new rows in chronological order.
    // Simpler: rewrite the whole file with a header + accumulated rows.
    // Parse existing rows back out:
    const existingRows = [];
    for (const line of existing.split('\n')) {
      if (!line.startsWith('| 20')) continue;
      const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
      if (cells.length >= 6) {
        existingRows.push({
          played_at: cells[0], track: cells[1], artist: cells[2], album: cells[3], duration_ms: cells[4], track_id: cells[5],
        });
      }
    }
    const all = [...existingRows, ...fresh].sort((a, b) => a.played_at.localeCompare(b.played_at));
    combinedTable = writeTable({ columns: ['played_at', 'track', 'artist', 'album', 'duration_ms', 'track_id'], rows: all });
  } else {
    combinedTable = writeTable({ columns: ['played_at', 'track', 'artist', 'album', 'duration_ms', 'track_id'], rows: newRows });
  }
  await atomicWrite(workspaceDir, rpPath,
    `---\ndescription: Spotify — recently played, append-only ledger (auto-pulled)\n---\n\n` +
    `# Recently Played — ${me.display_name ?? me.id}\n\nLast pulled ${nowISO()}.${gapDetected ? ' **Gap detected: >50 plays since last sync.**' : ''}\n\n` +
    combinedTable,
    { trust: 'untrusted', trustSource: 'sync-spotify' }
  );
  await linkAfterWrite(workspaceDir, registry, rpPath);

  // Top tracks
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/spotify/top-tracks.md',
    `---\ndescription: Spotify top tracks across 4w / 6m / all-time (auto-pulled)\n---\n\n` +
    `# Top Tracks — ${me.display_name ?? me.id}\n\nPulled ${nowISO()}.\n\n` +
    `## Last 4 weeks\n\n${writeTable({ columns: ['track', 'artist', 'album', 'popularity', 'duration_ms', 'track_id'], rows: (t4w.items ?? []).map(topTrackRow) })}\n` +
    `## Last 6 months\n\n${writeTable({ columns: ['track', 'artist', 'album', 'popularity', 'duration_ms', 'track_id'], rows: (t6m.items ?? []).map(topTrackRow) })}\n` +
    `## All time\n\n${writeTable({ columns: ['track', 'artist', 'album', 'popularity', 'duration_ms', 'track_id'], rows: (tAll.items ?? []).map(topTrackRow) })}`,
    { trust: 'untrusted', trustSource: 'sync-spotify' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/spotify/top-tracks.md');

  // Top artists
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/spotify/top-artists.md',
    `---\ndescription: Spotify top artists across 4w / 6m / all-time (auto-pulled)\n---\n\n` +
    `# Top Artists — ${me.display_name ?? me.id}\n\nPulled ${nowISO()}.\n\n` +
    `## Last 4 weeks\n\n${writeTable({ columns: ['artist', 'genres', 'followers', 'popularity', 'artist_id'], rows: (a4w.items ?? []).map(topArtistRow) })}\n` +
    `## Last 6 months\n\n${writeTable({ columns: ['artist', 'genres', 'followers', 'popularity', 'artist_id'], rows: (a6m.items ?? []).map(topArtistRow) })}\n` +
    `## All time\n\n${writeTable({ columns: ['artist', 'genres', 'followers', 'popularity', 'artist_id'], rows: (aAll.items ?? []).map(topArtistRow) })}`,
    { trust: 'untrusted', trustSource: 'sync-spotify' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/spotify/top-artists.md');

  // Lazy audio-features for all tracks we just saw
  const trackIds = [...new Set([
    ...newRows.map((r) => r.track_id).filter(Boolean),
    ...(t4w.items ?? []).map((t) => t.id).filter(Boolean),
  ])];
  // Fetch features for tracks we don't already have a file for
  const toFetch = [];
  for (const id of trackIds) {
    const path = `user-data/memory/knowledge/spotify/audio-features/${id}.md`;
    if (!existsSync(join(workspaceDir, path))) toFetch.push(id);
  }
  if (toFetch.length > 0) {
    let features = [];
    try {
      features = await client.audioFeatures(toFetch);
    } catch (err) {
      if (err?.status === 403) {
        console.warn('[sync-spotify] /audio-features returned 403 — skipping (Spotify deprecated this endpoint for apps created Nov 2024+).');
      } else {
        throw err;
      }
    }
    for (const f of features) {
      if (!f) continue;
      const path = `user-data/memory/knowledge/spotify/audio-features/${f.id}.md`;
      const fm = [
        '---',
        `description: Spotify audio features for track ${f.id}`,
        `track_id: ${f.id}`,
        `tempo: ${f.tempo ?? ''}`,
        `key: ${f.key ?? ''}`,
        `mode: ${f.mode ?? ''}`,
        `time_signature: ${f.time_signature ?? ''}`,
        `danceability: ${f.danceability ?? ''}`,
        `energy: ${f.energy ?? ''}`,
        `valence: ${f.valence ?? ''}`,
        `acousticness: ${f.acousticness ?? ''}`,
        `instrumentalness: ${f.instrumentalness ?? ''}`,
        `liveness: ${f.liveness ?? ''}`,
        `speechiness: ${f.speechiness ?? ''}`,
        '---',
        '',
      ].join('\n');
      await openItem(workspaceDir, path, async () => fm);
      await linkAfterWrite(workspaceDir, registry, path);
    }
    if (features.length > 0) {
      console.log(`[sync-spotify] cached ${features.length} audio-features files`);
    }
  }

  // Playlists (bootstrap mode only — full sweep is API-heavy)
  if (bootstrap && playlists.length > 0) {
    let skipped = 0;
    for (const p of playlists.slice(0, 50)) {
      const path = `user-data/memory/knowledge/spotify/playlists/${p.id}.md`;
      let tracks;
      try {
        tracks = await client.playlistTracks(p.id, { cap: 200 });
      } catch (err) {
        if (err?.status === 403 || err?.status === 404) {
          // Spotify-owned editorial/algorithmic playlists (Discover Weekly, Daily Mix, etc.) are restricted for apps created after Nov 2024.
          skipped++;
          continue;
        }
        throw err;
      }
      const lines = [
        '---',
        `description: Spotify playlist — ${p.name} (${p.tracks?.total ?? 0} tracks, owner: ${p.owner?.display_name ?? p.owner?.id})`,
        `playlist_id: ${p.id}`,
        `name: ${JSON.stringify(p.name ?? '')}`,
        `owner: ${p.owner?.display_name ?? p.owner?.id ?? ''}`,
        `public: ${p.public ?? false}`,
        `collaborative: ${p.collaborative ?? false}`,
        '---',
        '',
        `# ${p.name}`,
        '',
        writeTable({
          columns: ['track', 'artist', 'album', 'duration_ms'],
          rows: tracks.map((it) => ({
            track: it.track?.name ?? '',
            artist: (it.track?.artists ?? []).map((a) => a.name).join(', '),
            album: it.track?.album?.name ?? '',
            duration_ms: String(it.track?.duration_ms ?? ''),
          })),
        }),
      ];
      await atomicWrite(workspaceDir, path, lines.join('\n'), { trust: 'untrusted', trustSource: 'sync-spotify' });
      await linkAfterWrite(workspaceDir, registry, path);
    }
    const wrote = Math.min(playlists.length, 50) - skipped;
    console.log(`[sync-spotify] wrote ${wrote} playlist snapshots${skipped > 0 ? ` (${skipped} skipped — Spotify-restricted endpoints)` : ''}`);
  }

  // Update cursor
  const lastReturned = newRows[newRows.length - 1]?.played_at ?? lastPlayedAt;
  saveCursor(workspaceDir, SOURCE, {
    last_attempt_at: nowISO(),
    last_success_at: nowISO(),
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: {
      last_played_at: lastReturned,
      gap_detected: gapDetected,
      total_top_tracks_seen: (t4w.items?.length ?? 0) + (t6m.items?.length ?? 0) + (tAll.items?.length ?? 0),
    },
  });

  await updateIndex(workspaceDir, { skipIfLocked: true });
  console.log(`[sync-spotify] done${gapDetected ? ' (gap detected — consider raising cron frequency)' : ''}`);
  return { recently_played: newRows.length, audio_features_added: toFetch.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  const bootstrap = process.argv.includes('--bootstrap');

  const underRunner = !!process.env.ROBIN_WORKSPACE;
  const lockPath = join(workspaceDir, `user-data/runtime/state/jobs/locks/${SOURCE}.lock`);
  let acquired = false;

  async function run() {
    if (!underRunner) {
      const r = acquireLock(lockPath, { host: hostname() });
      if (r === 'held') {
        console.log(`[${SOURCE}] another instance is running (lock held); exiting.`);
        return;
      }
      acquired = true;
    }
    try {
      await syncSpotify({ workspaceDir, dryRun, bootstrap });
    } finally {
      if (acquired) releaseLock(lockPath);
    }
  }

  run().catch((err) => {
    try {
      saveCursor(workspaceDir, SOURCE, {
        last_attempt_at: nowISO(),
        last_error: err.message,
        error_count: (loadCursor(workspaceDir, SOURCE).error_count ?? 0) + 1,
        auth_status: err.name === 'AuthError' ? 'needs_reauth' : 'unknown',
      });
    } catch { /* ignore */ }
    if (acquired) {
      try { releaseLock(lockPath); } catch { /* ignore */ }
    }
    console.error(`[${SOURCE}] failed: ${err.message}`);
    process.exit(1);
  });
}

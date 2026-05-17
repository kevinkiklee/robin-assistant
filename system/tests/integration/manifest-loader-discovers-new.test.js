import assert from 'node:assert';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '../../io/integrations/_framework/manifest-loader.js';

// Post-v2: integration manifests live under BOTH system/io/integrations
// (framework + gmail/google_calendar/weather) AND user-data/io/integrations
// (everything else). loadManifests accepts an array of dirs; system first,
// user-data second, so user-data overrides on collision.
const systemDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../io/integrations');
const userDataDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../user-data/io/integrations',
);

test('manifest loader discovers github, spotify, letterboxd from user-data', async () => {
  const { loaded, unavailable } = await loadManifests([systemDir, userDataDir]);
  const names = [...loaded, ...unavailable].map((m) => m.name);
  assert.ok(names.includes('github'), `missing github (got ${names.join(', ')})`);
  assert.ok(names.includes('spotify'), `missing spotify (got ${names.join(', ')})`);
  assert.ok(names.includes('letterboxd'), `missing letterboxd (got ${names.join(', ')})`);
});

test('user-data integrations have expected cadence + secrets', async () => {
  const { loaded, unavailable } = await loadManifests([systemDir, userDataDir]);
  const all = [...loaded, ...unavailable];
  const gh = all.find((m) => m.name === 'github');
  const sp = all.find((m) => m.name === 'spotify');
  const lb = all.find((m) => m.name === 'letterboxd');

  assert.ok(gh.secrets?.env_keys?.includes('GITHUB_PAT'), 'github expects GITHUB_PAT');
  assert.ok(
    sp.secrets?.env_keys?.includes('SPOTIFY_REFRESH_TOKEN'),
    'spotify expects SPOTIFY_REFRESH_TOKEN',
  );
  assert.equal(lb.secrets?.env_keys?.length ?? 0, 0, 'letterboxd should have no env_keys');
});

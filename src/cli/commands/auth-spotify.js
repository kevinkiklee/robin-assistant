import { runAuthFlow } from './auth-google.js';

export async function authSpotify(argv) {
  return await runAuthFlow({
    provider: 'spotify',
    refreshTokenEnv: 'SPOTIFY_REFRESH_TOKEN',
    clientEnvKeys: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    argv,
  });
}

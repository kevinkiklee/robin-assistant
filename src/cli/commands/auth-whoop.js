import { runAuthFlow } from './auth-google.js';

export async function authWhoop(argv) {
  return await runAuthFlow({
    provider: 'whoop',
    refreshTokenEnv: 'WHOOP_REFRESH_TOKEN',
    clientEnvKeys: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
    argv,
  });
}

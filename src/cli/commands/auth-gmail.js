import { spawn } from 'node:child_process';
import { runLoopbackAuth } from '../../integrations/_auth/oauth2-google.js';
import { readSecrets, writeSecrets } from '../../integrations/_auth/secrets-io.js';
import { confirm, input } from '../prompts.js';

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

export async function authGmail() {
  const existing = await readSecrets('gmail');
  if (existing) {
    const overwrite = await confirm('gmail.json already exists. Overwrite?');
    if (!overwrite) {
      console.log('aborted');
      return;
    }
  }
  const client_id = await input('Google OAuth client_id: ');
  const client_secret = await input('Google OAuth client_secret: ');
  const tokens = await runLoopbackAuth({
    client_id,
    client_secret,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    openFn: openUrl,
  });
  await writeSecrets('gmail', { client_id, client_secret, ...tokens });
  console.log('gmail authenticated; secrets written.');
}

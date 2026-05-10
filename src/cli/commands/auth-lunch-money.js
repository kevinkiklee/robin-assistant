import { validateApiKey } from '../../integrations/_auth/api-key.js';
import { writeSecrets } from '../../integrations/_auth/secrets-io.js';
import { input } from '../prompts.js';

export async function authLunchMoney() {
  const api_key = await input('Lunch Money API key: ');
  const me = await validateApiKey({
    baseUrl: 'https://dev.lunchmoney.app',
    key: api_key,
    testPath: '/v1/me',
  });
  await writeSecrets('lunch_money', { api_key });
  console.log(
    `lunch_money authenticated as ${me.user_email ?? me.user_name ?? '(unknown)'}; secrets written.`,
  );
}

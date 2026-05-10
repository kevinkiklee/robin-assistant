import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function secretsDir() {
  return process.env.ROBIN_HOME
    ? join(process.env.ROBIN_HOME, 'secrets')
    : join(homedir(), '.robin', 'secrets');
}

export function secretsPath(name) {
  return join(secretsDir(), `${name}.json`);
}

export async function readSecrets(name) {
  try {
    const text = await readFile(secretsPath(name), 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSecrets(name, data) {
  const path = secretsPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  await chmod(path, 0o600);
}

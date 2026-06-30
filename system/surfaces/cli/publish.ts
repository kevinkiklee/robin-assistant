import { join, resolve as resolvePath } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { resolveUserDataDir } from '../../lib/paths.ts';
import {
  createBlobClient,
  EXIT_CRASH,
  EXIT_INPUT,
  EXIT_OK,
  groupBySlug,
  PublishError,
  type PublishMode,
  readLog,
  publish as runPublish,
} from '../../lib/publish/index.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

function logPathFor(userData: string): string {
  return join(userData, 'observability', 'publish', 'index.jsonl');
}
function telemetryPathFor(userData: string): string {
  return join(userData, 'observability', 'logs', 'publish.log');
}

function readEnvFromProcess(): {
  token: string | undefined;
  privateToken: string | undefined;
  userId: string | undefined;
  publicUrl: string;
  blobPublicBaseUrl: string | undefined;
} {
  return {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    privateToken: process.env.BLOB_PRIVATE_READ_WRITE_TOKEN,
    userId: process.env.PUBLISH_USER_ID,
    publicUrl: process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io',
    blobPublicBaseUrl: process.env.BLOB_PUBLIC_BASE_URL,
  };
}

export async function runPublishCli(rawArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      source: { type: 'string' },
      slug: { type: 'string' },
      mode: { type: 'string', default: 'default' },
      'force-untrusted': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const userData = resolveUserDataDir();
  loadEnvFile(userData); // populates process.env from secrets/.env if not already set
  const env = readEnvFromProcess();

  if (!env.token) {
    stderr.write('BLOB_READ_WRITE_TOKEN missing — set in user-data/config/secrets/.env\n');
    exit(EXIT_INPUT);
  }
  if (!env.userId) {
    stderr.write('PUBLISH_USER_ID missing — set in user-data/config/secrets/.env\n');
    exit(EXIT_INPUT);
  }
  if (!env.blobPublicBaseUrl) {
    stderr.write('BLOB_PUBLIC_BASE_URL missing — set in user-data/config/secrets/.env\n');
    exit(EXIT_INPUT);
  }

  const blobClient = createBlobClient({ token: env.token });
  const privateBlobClient = env.privateToken ? createBlobClient({ token: env.privateToken }) : null;

  const mode = (values.mode ?? 'default') as PublishMode;
  if (!['default', 'overwrite', 'as-new', 'delete'].includes(mode)) {
    stderr.write(`unknown mode: ${mode} (expected default | overwrite | as-new | delete)\n`);
    exit(EXIT_INPUT);
  }

  try {
    const result = await runPublish({
      source: values.source ? resolvePath(values.source) : null,
      slug: values.slug ?? null,
      mode,
      forceUntrusted: values['force-untrusted'] ?? false,
      dryRun: values['dry-run'] ?? false,
      env: {
        token: env.token,
        userId: env.userId,
        publicUrl: env.publicUrl,
        blobPublicBaseUrl: env.blobPublicBaseUrl,
      },
      blobClient,
      privateBlobClient,
      logPath: logPathFor(userData),
      telemetryPath: telemetryPathFor(userData),
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    exit(EXIT_OK);
  } catch (err) {
    if (err instanceof PublishError) {
      stderr.write(`${err.message}\n`);
      exit(err.code);
    }
    stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    exit(EXIT_CRASH);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export async function runPublishedCli(rawArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: { all: { type: 'boolean', default: false } },
    strict: true,
  });

  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  const userId = process.env.PUBLISH_USER_ID || 'user';
  const { entries, skipped } = await readLog(logPathFor(userData));
  if (entries.length === 0) {
    stdout.write('(no published pages)\n');
    if (skipped) stdout.write(`(skipped ${skipped} malformed entries)\n`);
    return;
  }
  const rows = values.all
    ? entries.map((e) => ({
        slug: e.slug,
        lastTs: e.ts,
        lastAction: e.action,
        count: 1,
        lastSource: e.source,
      }))
    : groupBySlug(entries);
  const sorted = [...rows].sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  for (const r of sorted) {
    const ts = (r.lastTs ?? '').replace('T', ' ').slice(0, 16);
    const url = `/@${userId}/${trunc(r.slug, 30 - userId.length - 2)}`;
    const action = r.lastAction === 'delete' ? 'DELETED' : (r.lastAction ?? '');
    const count = r.lastAction === 'delete' ? '—' : `${r.count}×`;
    const source = r.lastAction === 'delete' ? '—' : trunc(r.lastSource ?? '', 40);
    stdout.write(`${pad(ts, 17)}${pad(url, 33)}${pad(action, 12)}${pad(count, 6)}${source}\n`);
  }
  if (skipped) stdout.write(`(skipped ${skipped} malformed entries)\n`);
}

// Allow direct invocation via `tsx system/surfaces/cli/publish.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const sub = argv[2];
  if (sub === 'published') void runPublishedCli(argv.slice(3));
  else void runPublishCli(argv.slice(2));
}

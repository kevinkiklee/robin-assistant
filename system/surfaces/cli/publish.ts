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
  recategorize,
  publish as runPublish,
  syncDeletes,
} from '../../lib/publish/index.ts';
import {
  CHROME_PATH,
  canCapture,
  captureWithChrome,
  updateThumbs,
} from '../../lib/publish/thumbs.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

function logPathFor(userData: string): string {
  return join(userData, 'observability', 'publish', 'index.jsonl');
}
function telemetryPathFor(userData: string): string {
  return join(userData, 'observability', 'logs', 'publish.log');
}

function readEnvFromProcess(): {
  token: string | undefined;
  userId: string | undefined;
  publicUrl: string;
  blobPublicBaseUrl: string | undefined;
  urlSecret: string | undefined;
} {
  return {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    userId: process.env.PUBLISH_USER_ID,
    publicUrl: process.env.PUBLISH_PUBLIC_URL || 'https://askrobin.io',
    blobPublicBaseUrl: process.env.BLOB_PUBLIC_BASE_URL,
    urlSecret: process.env.PUBLISH_URL_SECRET,
  };
}

export async function runPublishCli(rawArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      source: { type: 'string' },
      slug: { type: 'string' },
      mode: { type: 'string', default: 'default' },
      category: { type: 'string' },
      'force-untrusted': { type: 'boolean', default: false },
      'allow-sensitive': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
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
  if (!env.urlSecret) {
    // Fail closed: publishing without the secret would mint unhashed
    // (guessable) URLs and split every page's identity.
    stderr.write('PUBLISH_URL_SECRET missing — set in user-data/config/secrets/.env\n');
    exit(EXIT_INPUT);
  }

  const blobClient = createBlobClient({ token: env.token });

  const mode = values.mode ?? 'default';
  if (
    !['default', 'overwrite', 'as-new', 'delete', 'recategorize', 'sync', 'thumbs'].includes(mode)
  ) {
    stderr.write(
      `unknown mode: ${mode} (expected default | overwrite | as-new | delete | recategorize | sync | thumbs)\n`,
    );
    exit(EXIT_INPUT);
  }

  const maintainOpts = {
    env: {
      token: env.token,
      userId: env.userId,
      publicUrl: env.publicUrl,
      blobPublicBaseUrl: env.blobPublicBaseUrl,
      urlSecret: env.urlSecret,
    },
    blobClient,
    logPath: logPathFor(userData),
  };

  try {
    // Maintenance modes — no source markdown involved.
    if (mode === 'recategorize') {
      if (!values.slug || !values.category) {
        stderr.write('--slug and --category required for mode=recategorize\n');
        exit(EXIT_INPUT);
      }
      const result = await recategorize({
        ...maintainOpts,
        slug: values.slug,
        category: values.category,
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      exit(EXIT_OK);
    }
    if (mode === 'thumbs') {
      // Backfill / refresh screenshot thumbnails for photo-less pages.
      if (!canCapture()) {
        stderr.write(`thumbs needs Google Chrome at ${CHROME_PATH} and macOS sips\n`);
        exit(EXIT_INPUT);
      }
      const result = await updateThumbs({
        env: maintainOpts.env,
        blobClient,
        capture: captureWithChrome,
        slugs: values.slug ? [values.slug] : undefined,
        force: values.force ?? false,
        log: (line) => stderr.write(`${line}\n`),
      });
      stdout.write(
        `${JSON.stringify({ ...result, captured: result.captured.length, captured_slugs: result.captured }, null, 2)}\n`,
      );
      exit(EXIT_OK);
    }
    if (mode === 'sync') {
      const result = await syncDeletes(maintainOpts);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      exit(EXIT_OK);
    }
  } catch (err) {
    if (err instanceof PublishError) {
      stderr.write(`${err.message}\n`);
      exit(err.code);
    }
    stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    exit(EXIT_CRASH);
  }

  try {
    const result = await runPublish({
      source: values.source ? resolvePath(values.source) : null,
      slug: values.slug ?? null,
      mode: mode as PublishMode,
      forceUntrusted: values['force-untrusted'] ?? false,
      allowSensitive: values['allow-sensitive'] ?? false,
      dryRun: values['dry-run'] ?? false,
      env: {
        token: env.token,
        userId: env.userId,
        publicUrl: env.publicUrl,
        blobPublicBaseUrl: env.blobPublicBaseUrl,
        urlSecret: env.urlSecret,
      },
      blobClient,
      logPath: logPathFor(userData),
      telemetryPath: telemetryPathFor(userData),
      thumbCapture: canCapture() ? captureWithChrome : undefined,
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

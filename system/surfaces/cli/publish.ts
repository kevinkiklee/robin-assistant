import { join, resolve as resolvePath } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { resolveUserDataDir } from '../../lib/paths.ts';
import {
  createBlobClient,
  deletePage,
  EXIT_CRASH,
  EXIT_INPUT,
  EXIT_OK,
  groupBySlug,
  PublishError,
  type PublishMode,
  publishEnvFromProcess,
  publishLogPath,
  readLog,
  recategorize,
  publish as runPublish,
} from '../../lib/publish/index.ts';
import {
  CHROME_PATH,
  canCapture,
  captureWithChrome,
  updateThumbs,
} from '../../lib/publish/thumbs.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

function telemetryPathFor(userData: string): string {
  return join(userData, 'observability', 'logs', 'publish.log');
}

const MODES = ['default', 'overwrite', 'as-new', 'delete', 'recategorize', 'thumbs'];

/** Why `--mode <mode>` can't run, or null when it can. */
export function publishModeError(mode: string): string | null {
  if (MODES.includes(mode)) return null;
  if (mode === 'sync') {
    return (
      'mode sync was removed: the askrobin page index and its web-side edit queue are gone. ' +
      'Page edits made in the dashboard are applied by the life_sync integration.'
    );
  }
  return `unknown mode: ${mode} (expected ${MODES.join(' | ')})`;
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

  const mode = values.mode ?? 'default';
  const modeError = publishModeError(mode);
  if (modeError) {
    stderr.write(`${modeError}\n`);
    exit(EXIT_INPUT);
  }

  const userData = resolveUserDataDir();
  loadEnvFile(userData); // populates process.env from secrets/.env if not already set
  const env = publishEnvFromProcess();

  if (!env) {
    // Name the first missing variable (PUBLISH_URL_SECRET fails closed:
    // publishing without it would mint unhashed, guessable URLs).
    const missing = [
      'BLOB_READ_WRITE_TOKEN',
      'PUBLISH_USER_ID',
      'BLOB_PUBLIC_BASE_URL',
      'PUBLISH_URL_SECRET',
    ].find((k) => !process.env[k]);
    stderr.write(`${missing} missing — set in user-data/config/secrets/.env\n`);
    exit(EXIT_INPUT);
  }

  const blobClient = createBlobClient({ token: env.token });

  const maintainOpts = {
    env,
    blobClient,
    logPath: publishLogPath(userData),
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
        logPath: maintainOpts.logPath,
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
    if (mode === 'delete') {
      const result = await deletePage({
        ...maintainOpts,
        slug: values.slug ?? '',
        telemetryPath: telemetryPathFor(userData),
        dryRun: values['dry-run'] ?? false,
      });
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
      env,
      blobClient,
      logPath: publishLogPath(userData),
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
  const { entries, skipped } = await readLog(publishLogPath(userData));
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

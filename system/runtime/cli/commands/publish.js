// `robin publish` — publish a markdown file to the web.
//
// Ported from v1 (system/scripts/cli/publish.js) and adapted to v2:
//   - Secrets read from v2's getSecret() (not process.env)
//   - Log + telemetry paths resolved under paths.data.home()
//   - Peer deps pre-checked so users without `npm install @vercel/blob ...`
//     get a clean remediation line instead of ERR_MODULE_NOT_FOUND.

import { join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { paths } from '../../../config/data-store.js';
import { getSecret } from '../../../config/secrets.js';

const PUBLISH_PEERS = [
  '@vercel/blob',
  'remark-gfm',
  'remark-parse',
  'remark-rehype',
  'rehype-raw',
  'rehype-sanitize',
  'rehype-slug',
  'rehype-stringify',
  'unified',
  'unist-util-visit',
  'gray-matter',
  'file-type',
  'nanoid',
];

async function checkPeers() {
  const missing = [];
  for (const spec of PUBLISH_PEERS) {
    try {
      await import(spec);
    } catch {
      missing.push(spec);
    }
  }
  return missing;
}

export async function publish(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      slug: { type: 'string' },
      mode: { type: 'string', default: 'default' },
      'force-untrusted': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const env = {
    token: getSecret('BLOB_READ_WRITE_TOKEN'),
    userId: getSecret('PUBLISH_USER_ID'),
    publicUrl: getSecret('PUBLISH_PUBLIC_URL') || 'https://askrobin.io',
    blobPublicBaseUrl: getSecret('BLOB_PUBLIC_BASE_URL'),
    // repoRoot is only used to resolve relative log/telemetry paths; we pass
    // absolute paths below, so this value is effectively unused.
    repoRoot: paths.data.home(),
  };

  if (!env.token) {
    process.stderr.write(
      'BLOB_READ_WRITE_TOKEN missing — set with: robin secrets set BLOB_READ_WRITE_TOKEN=...\n',
    );
    process.exit(3);
  }
  if (!env.userId) {
    process.stderr.write(
      'PUBLISH_USER_ID missing — set with: robin secrets set PUBLISH_USER_ID=...\n',
    );
    process.exit(3);
  }
  if (!env.blobPublicBaseUrl) {
    process.stderr.write(
      'BLOB_PUBLIC_BASE_URL missing — set with: robin secrets set BLOB_PUBLIC_BASE_URL=...\n',
    );
    process.exit(3);
  }

  const missing = await checkPeers();
  if (missing.length > 0) {
    process.stderr.write(
      `robin publish requires peer dependencies that aren't installed:\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\n\nInstall in this workspace:\n  npm install ${missing.join(' ')}\n`,
    );
    process.exit(3);
  }

  const { publish: runPublish, PublishError } = await import('../../../io/publish/orchestrate.js');
  const { createBlobClient } = await import('../../../io/publish/blob.js');
  const { EXIT_OK, EXIT_CRASH } = await import('../../../io/publish/config.js');

  const blobClient = createBlobClient({ token: env.token });

  // Absolute paths under user-data home — keeps publish state colocated with
  // the rest of Robin's writable state.
  const logPath = paths.data.publishIndex();
  const telemetryPath = join(paths.data.logs(), 'publish.log');

  try {
    const result = await runPublish({
      source: values.source ? resolvePath(values.source) : null,
      slug: values.slug ?? null,
      mode: values.mode,
      forceUntrusted: values['force-untrusted'],
      dryRun: values['dry-run'],
      env,
      blobClient,
      logPath,
      telemetryPath,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof PublishError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.code);
    }
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(EXIT_CRASH);
  }
}

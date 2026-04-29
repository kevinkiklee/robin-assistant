#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by skeleton-sync.
// Imports resolve only after copy; not runnable in place.
//
// GitHub write CLI. Single entry point dispatched on --action.
//
// Usage examples:
//   node user-data/scripts/github-write.js --action create-issue \
//     --json '{"repo":"acme/foo","title":"Hello","body":"world","labels":["bug"]}'
//
//   node user-data/scripts/github-write.js --action comment \
//     --json '{"repo":"acme/foo","number":123,"body":"Thanks!"}'
//
//   node user-data/scripts/github-write.js --action label \
//     --json '{"repo":"acme/foo","number":123,"labels":["bug","p1"]}'
//
//   node user-data/scripts/github-write.js --action mark-read \
//     --json '{"thread_id":"12345"}'
//
// All actions write externally-visible state. Per AGENTS.md `Rule: Ask vs Act`,
// the agent must confirm with the user before invoking this script.

import { fileURLToPath } from 'node:url';
import { loadSecrets, requireSecret } from '../../system/scripts/lib/sync/secrets.js';
import { GitHubClient } from './lib/github/client.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--action') out.action = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function splitRepo(spec) {
  const [owner, repo] = String(spec).split('/');
  if (!owner || !repo) throw new Error(`Invalid repo: ${spec} (expected "owner/repo")`);
  return { owner, repo };
}

const HANDLERS = {
  'create-issue': async (client, payload) => {
    const { owner, repo } = splitRepo(payload.repo);
    if (!payload.title) throw new Error('create-issue: title is required');
    return client.createIssue(owner, repo, {
      title: payload.title,
      body: payload.body,
      labels: payload.labels,
      assignees: payload.assignees,
    });
  },
  comment: async (client, payload) => {
    const { owner, repo } = splitRepo(payload.repo);
    if (typeof payload.number !== 'number') throw new Error('comment: number is required');
    if (!payload.body) throw new Error('comment: body is required');
    return client.createComment(owner, repo, payload.number, payload.body);
  },
  label: async (client, payload) => {
    const { owner, repo } = splitRepo(payload.repo);
    if (typeof payload.number !== 'number') throw new Error('label: number is required');
    if (!Array.isArray(payload.labels)) throw new Error('label: labels (array) is required');
    return client.setLabels(owner, repo, payload.number, payload.labels);
  },
  'mark-read': async (client, payload) => {
    if (!payload.thread_id) throw new Error('mark-read: thread_id is required');
    await client.markNotificationRead(payload.thread_id);
    return { ok: true };
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) {
    console.error(`Usage: github-write.js --action <create-issue|comment|label|mark-read> --json '{...}'`);
    process.exit(2);
  }
  if (!HANDLERS[args.action]) {
    console.error(`Unknown action: ${args.action}. Known: ${Object.keys(HANDLERS).join(', ')}`);
    process.exit(2);
  }
  if (!args.json) {
    console.error('Missing --json payload');
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(args.json);
  } catch (err) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(`[github-write] DRY-RUN action=${args.action} payload=${JSON.stringify(payload)}`);
    return;
  }

  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  loadSecrets(workspaceDir);
  const pat = requireSecret('GITHUB_PAT');
  const client = new GitHubClient(pat);

  const result = await HANDLERS[args.action](client, payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`[github-write] failed: ${err.message}`);
  process.exit(1);
});

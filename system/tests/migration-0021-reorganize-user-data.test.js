import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as migration from '../migrations/0021-reorganize-user-data.js';
import { createHelpers } from '../scripts/lib/migration-helpers.js';

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mig-0021-'));
  const ud = join(root, 'user-data');

  // Top-level files
  mkdirSync(ud, { recursive: true });
  writeFileSync(join(ud, 'manifest.md'), '# Memory Manifest\n');
  writeFileSync(join(ud, 'integrations.md'), '# Integrations\n');
  writeFileSync(join(ud, 'policies.md'), '# Policies\n');
  writeFileSync(join(ud, 'robin.config.json'), JSON.stringify({ version: '3.0.0' }) + '\n');
  writeFileSync(join(ud, '.migrations-applied.json'), JSON.stringify({ applied: [] }));

  // Top-level dirs
  for (const d of ['jobs', 'scripts', 'secrets', 'security', 'sources/notes']) {
    mkdirSync(join(ud, d), { recursive: true });
  }
  writeFileSync(join(ud, 'jobs/morning-briefing.md'), '# Morning Briefing\n');
  writeFileSync(join(ud, 'scripts/sync-gmail.js'), '// sync gmail\n');
  writeFileSync(join(ud, 'secrets/.env'), 'GITHUB_PAT=fake\n');
  writeFileSync(join(ud, 'secrets/.gitignore'), '*\n!.gitignore\n!README.md\n');
  writeFileSync(join(ud, 'secrets/README.md'), '# Secrets\n');
  writeFileSync(join(ud, 'security/manifest.json'), JSON.stringify({ version: 1 }));
  writeFileSync(join(ud, 'sources/notes/example.md'), '# Notes\n');

  // memory/ root files (loose) + subdirs
  mkdirSync(join(ud, 'memory/profile'), { recursive: true });
  mkdirSync(join(ud, 'memory/knowledge/service-providers'), { recursive: true });
  mkdirSync(join(ud, 'memory/self-improvement'), { recursive: true });
  mkdirSync(join(ud, 'memory/watches'), { recursive: true });
  mkdirSync(join(ud, 'memory/archive'), { recursive: true });
  mkdirSync(join(ud, 'memory/quarantine'), { recursive: true });
  for (const f of ['INDEX.md', 'ENTITIES.md', 'LINKS.md', 'hot.md',
                   'inbox.md', 'journal.md', 'log.md', 'decisions.md', 'tasks.md']) {
    writeFileSync(join(ud, 'memory', f), `# ${f}\n`);
  }
  writeFileSync(join(ud, 'memory/self-improvement.md.pre-0008'), '# stale\n');
  writeFileSync(join(ud, 'memory/knowledge/service-providers.md'), '# stub\n');
  writeFileSync(join(ud, 'memory/knowledge/service-providers/abco.md'), '# Abco\n');
  writeFileSync(join(ud, 'memory/profile/identity.md'), '# Identity\n');

  // state/ — files + subdirs (mirrors live layout)
  mkdirSync(join(ud, 'state/jobs/locks'), { recursive: true });
  mkdirSync(join(ud, 'state/jobs/logs'), { recursive: true });
  mkdirSync(join(ud, 'state/sync'), { recursive: true });
  mkdirSync(join(ud, 'state/watches'), { recursive: true });
  mkdirSync(join(ud, 'state/locks'), { recursive: true });  // empty — to be deleted
  mkdirSync(join(ud, 'state/logs'), { recursive: true });   // daemon logs — to be services/

  writeFileSync(join(ud, 'state/sessions.md'), '# Sessions\n');
  writeFileSync(join(ud, 'state/dream-state.md'), 'last_dream_at: 2026-04-30T20:50:00Z\n');
  writeFileSync(join(ud, 'state/turn.json'), '{}');
  writeFileSync(join(ud, 'state/capture-retry.json'), '{}');
  writeFileSync(join(ud, 'state/pending-asks.md'), '# Pending\n');
  writeFileSync(join(ud, 'state/high-stakes-writes.log'), '');
  writeFileSync(join(ud, 'state/policy-refusals.log'), '');
  writeFileSync(join(ud, 'state/capture-enforcement.log'), '');
  writeFileSync(join(ud, 'state/turn-writes.log'), '');
  writeFileSync(join(ud, 'state/discord-bot.status.json'), '{}');
  writeFileSync(join(ud, 'state/discord-sessions.json'), '{}');
  writeFileSync(join(ud, 'state/entities-hash.txt'), 'abc123');
  writeFileSync(join(ud, 'state/logs/discord-bot.log'), '');
  writeFileSync(join(ud, 'state/jobs/.notification-state.json'), '{}');
  writeFileSync(join(ud, 'state/jobs/.sync-hash'), 'hash');
  writeFileSync(join(ud, 'state/jobs/.workspace-path'), '/tmp/x');
  writeFileSync(join(ud, 'state/jobs/INDEX.md'), '# Jobs\n');
  writeFileSync(join(ud, 'state/jobs/failures.md'), '# Failures\n');

  return { root, ud };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

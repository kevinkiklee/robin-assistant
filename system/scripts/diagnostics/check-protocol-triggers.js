#!/usr/bin/env node
// Lint: every protocol file in `system/jobs/` MUST declare a `triggers:` key.
// `triggers: []` is a valid intentional opt-out (e.g., scheduled-only protocols).
// The pre-protocol-override hook depends on this invariant for trigger-map
// completeness.
//
// Exit 0: clean. Exit 1: one or more protocols missing the key.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProtocolFrontmatter } from '../lib/protocol-frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_JOBS_DIR = join(REPO_ROOT, 'system', 'jobs');

function isProtocolFile(name) {
  return name.endsWith('.md') && !name.startsWith('_') && name !== 'README.md';
}

export function findProtocolsMissingTriggers(jobsDir = DEFAULT_JOBS_DIR) {
  if (!existsSync(jobsDir)) return [];
  const issues = [];
  const names = readdirSync(jobsDir).filter(isProtocolFile).sort();
  for (const name of names) {
    const path = join(jobsDir, name);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      issues.push(`${name}: unreadable (${err.message})`);
      continue;
    }
    let fm;
    try {
      ({ frontmatter: fm } = parseProtocolFrontmatter(text));
    } catch (err) {
      issues.push(`${name}: malformed frontmatter (${err.message})`);
      continue;
    }
    if (!('triggers' in fm)) {
      issues.push(`${name}: missing 'triggers' frontmatter key (use 'triggers: []' for intentional opt-out)`);
    }
  }
  return issues;
}

// CLI entry point.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const issues = findProtocolsMissingTriggers();
  if (issues.length === 0) {
    process.stdout.write('check-protocol-triggers: OK\n');
    process.exit(0);
  }
  process.stderr.write(`check-protocol-triggers: ${issues.length} issue(s):\n`);
  for (const i of issues) process.stderr.write(`  - ${i}\n`);
  process.exit(1);
}

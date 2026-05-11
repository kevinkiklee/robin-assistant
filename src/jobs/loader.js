import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const NOTIFY_VALUES = new Set(['discord_dm', 'capture', 'both', 'none']);
const RUNTIME_VALUES = new Set(['agent', 'internal']);

const DEFAULTS = {
  enabled: false,
  catch_up: false,
  timeout_minutes: 10,
  notify: 'none',
  notify_on_failure: true,
  manually_runnable: true,
  description: '',
};

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('no YAML frontmatter');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf(':');
    if (eq < 0) throw new Error(`bad frontmatter line: ${line}`);
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^-?\d+$/.test(v)) v = Number.parseInt(v, 10);
    else if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    fm[k] = v;
  }
  return { frontmatter: fm, body: m[2] };
}

export function validateJob(fm) {
  if (typeof fm.name !== 'string' || !fm.name) throw new Error('job: name required');
  if (typeof fm.schedule !== 'string' || !fm.schedule) throw new Error('job: schedule required');
  if (typeof fm.runtime !== 'string') throw new Error('job: runtime required');
  if (!RUNTIME_VALUES.has(fm.runtime)) {
    throw new Error(`job: runtime must be one of ${[...RUNTIME_VALUES].join('|')}`);
  }
  if (fm.notify !== undefined && !NOTIFY_VALUES.has(fm.notify)) {
    throw new Error(`job: notify must be one of ${[...NOTIFY_VALUES].join('|')}`);
  }
}

export function parseJobFile(filePath, source = 'builtin') {
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  validateJob(frontmatter);
  const expectedName = basename(filePath).replace(/\.md$/, '');
  if (frontmatter.name !== expectedName) {
    throw new Error(
      `job: filename '${expectedName}' must match frontmatter name '${frontmatter.name}'`,
    );
  }
  return { ...DEFAULTS, ...frontmatter, body, source, path: filePath };
}

function listMd(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

export function discoverJobs({ builtinDir, userDir }) {
  const byName = new Map();
  for (const p of listMd(builtinDir)) {
    try {
      const job = parseJobFile(p, 'builtin');
      byName.set(job.name, job);
    } catch (e) {
      console.warn(`[jobs] skip builtin ${p}: ${e.message}`);
    }
  }
  for (const p of listMd(userDir)) {
    try {
      const job = parseJobFile(p, 'user');
      byName.set(job.name, job); // user wins
    } catch (e) {
      console.warn(`[jobs] skip user ${p}: ${e.message}`);
    }
  }
  return [...byName.values()];
}

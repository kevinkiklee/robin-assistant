// brief-regenerate.js — CLI: force a fresh daily-brief synthesis.
//
// Usage:
//   robin brief regenerate              regenerate today's brief
//   robin brief regenerate --date YYYY-MM-DD
//
// Clears the intra-day synthesis cache for the given date and triggers a
// daily-briefing job run. The next fire will skip the reuse short-circuit
// and call Opus fresh.

import { spawn } from 'node:child_process';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

function localToday(tz = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseDateFlag(args) {
  const i = args.indexOf('--date');
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

export async function briefRegenerate(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  let args = argv.slice();
  if (args[0] === 'regenerate') args = args.slice(1);

  const date = parseDateFlag(args) ?? localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err(`invalid --date: ${date} (expected YYYY-MM-DD)`);
    if (deps.exit) deps.exit(2);
    return;
  }

  await ensureHome();
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    const id = `briefing_synthesis_cache_${date}`;
    await db.query(`DELETE runtime:\`${id}\``).collect();
    out(`cleared synthesis cache for ${date}`);
  } finally {
    await close(db);
  }

  // Spawn `robin jobs run daily-briefing` so the next fire happens immediately.
  // Detach so this CLI command returns even if the job is slow.
  if (deps.skipJob) return;
  await new Promise((resolve) => {
    const proc = spawn('robin', ['jobs', 'run', 'daily-briefing'], {
      stdio: 'inherit',
    });
    proc.on('exit', () => resolve());
    proc.on('error', (e) => {
      err(`failed to spawn 'robin jobs run daily-briefing': ${e.message}`);
      resolve();
    });
  });
}

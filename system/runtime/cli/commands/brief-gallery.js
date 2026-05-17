// brief-gallery.js — CLI: manage daily-brief photo galleries.
//
// Usage:
//   robin brief gallery private [--date YYYY-MM-DD]   suppress URL in the brief
//   robin brief gallery public  [--date YYYY-MM-DD]   restore default
//   robin brief gallery show    [--date YYYY-MM-DD]   show slot info
//
// Default date is local today (America/New_York to match the daily-briefing
// job's TZ).

import { surql } from 'surrealdb';
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

async function readSlot(db, date) {
  const id = `briefing_gallery_slug_${date}`;
  const [rows] = await db.query(`SELECT VALUE value FROM runtime:\`${id}\``).collect();
  return rows[0] ?? null;
}

async function writeSlot(db, date, value) {
  const id = `briefing_gallery_slug_${date}`;
  await db.query(surql`UPSERT type::record('runtime', ${id}) SET value = ${value}`).collect();
}

export async function briefGallery(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  let args = argv.slice();
  if (args[0] === 'gallery') args = args.slice(1);

  const action = args[0];
  if (!action || !['private', 'public', 'show'].includes(action)) {
    err('usage: robin brief gallery <private|public|show> [--date YYYY-MM-DD]');
    if (deps.exit) deps.exit(2);
    return;
  }
  const date = parseDateFlag(args) ?? localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err(`invalid --date: ${date} (expected YYYY-MM-DD)`);
    if (deps.exit) deps.exit(2);
    return;
  }

  await ensureHome();
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    const slot = (await readSlot(db, date)) ?? { date };
    if (action === 'show') {
      out(JSON.stringify(slot, null, 2));
      return;
    }
    const now = new Date().toISOString();
    if (action === 'private') {
      await writeSlot(db, date, { ...slot, private: true, updated_at: now });
      out(`gallery for ${date} marked PRIVATE (URL suppressed in future briefs)`);
    } else if (action === 'public') {
      const next = { ...slot, updated_at: now };
      delete next.private;
      await writeSlot(db, date, next);
      out(`gallery for ${date} marked PUBLIC`);
    }
  } finally {
    await close(db);
  }
}

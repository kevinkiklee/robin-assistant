import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  classifyMailPreview,
  createGmailMailPreviewTool,
} from '../../io/integrations/gmail/tools/gmail-mail-preview.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('classifyMailPreview extracts piece + package counts from Informed Delivery digest', () => {
  const r = classifyMailPreview({
    content:
      'Subject: Your Daily Digest — 5 mailpieces and 2 packages | From: USPSInformedDelivery@usps.gov\nHere is your mail today.',
    ts: '2026-05-15T13:00:00Z',
  });
  assert.equal(r.pieces, 5);
  assert.equal(r.packages, 2);
  assert.equal(r.date, '2026-05-15');
});

test('classifyMailPreview accepts piece-only digests', () => {
  const r = classifyMailPreview({
    content:
      'Subject: Informed Delivery: 3 mailpieces today | From: noreply@email.informeddelivery.usps.com\n',
    ts: '2026-05-14T13:00:00Z',
  });
  assert.equal(r.pieces, 3);
  assert.equal(r.packages, null);
});

test('classifyMailPreview rejects non-Informed-Delivery mail', () => {
  const r = classifyMailPreview({
    content: 'Subject: USPS tracking update | From: noreply@usps.com\nDelivered.',
    ts: '2026-05-15T10:00:00Z',
  });
  assert.equal(r, null);
});

test('classifyMailPreview rejects Informed Delivery emails without counts', () => {
  const r = classifyMailPreview({
    content:
      'Subject: Informed Delivery notification | From: USPSInformedDelivery@usps.gov\nNo mail expected today.',
    ts: '2026-05-15T13:00:00Z',
  });
  assert.equal(r, null);
});

test('gmail_mail_preview tool dedupes per day and totals counts', async () => {
  const db = await fresh();
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const earlierToday = new Date(today.getTime() - 60_000);
  const seeds = [
    {
      source: 'gmail',
      content:
        'Subject: Your Daily Digest — 4 mailpieces and 1 package | From: USPSInformedDelivery@usps.gov\n',
      ts: today,
      meta: { gmail_id: 't1' },
    },
    {
      // Earlier duplicate today — should be superseded by `today` above.
      source: 'gmail',
      content: 'Subject: Your Daily Digest — 2 mailpieces | From: USPSInformedDelivery@usps.gov\n',
      ts: earlierToday,
      meta: { gmail_id: 't0' },
    },
    {
      source: 'gmail',
      content: 'Subject: Your Daily Digest — 6 mailpieces | From: USPSInformedDelivery@usps.gov\n',
      ts: yesterday,
      meta: { gmail_id: 'y1' },
    },
    {
      source: 'gmail',
      content: 'Subject: Sale ends today | From: marketing@store.com\n',
      ts: today,
      meta: { gmail_id: 'noise' },
    },
  ];
  for (const s of seeds) {
    await db.query(surql`CREATE events CONTENT ${s}`).collect();
  }
  const t = createGmailMailPreviewTool({ db });
  const r = await t.handler({ days_back: 7 });
  assert.equal(r.count, 2);
  assert.equal(r.total_pieces, 10);
  assert.equal(r.total_packages, 1);
  assert.equal(r.latest.pieces, 4);
  await close(db);
});

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
  classifyShipment,
  createGmailShipmentsTool,
  parseGmailContent,
} from '../../io/integrations/gmail/tools/gmail-shipments.js';

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

test('parseGmailContent extracts subject + from + snippet', () => {
  const r = parseGmailContent(
    'Subject: Your package is out for delivery | From: UPS <noreply@ups.com>\nYour shipment is on its way.',
  );
  assert.match(r.subject, /out for delivery/);
  assert.match(r.from, /UPS/);
  assert.match(r.snippet, /on its way/);
});

test('classifyShipment buckets "out for delivery" as arriving_today', () => {
  const e = {
    content: 'Subject: Out for delivery — order #1234567 | From: UPS <noreply@ups.com>\nETA today.',
    ts: '2026-05-15T10:00:00Z',
    meta: { gmail_id: 'g1' },
  };
  const r = classifyShipment(e, {
    todayStr: '2026-05-15',
    yesterdayStr: '2026-05-14',
    tomorrowStr: '2026-05-16',
  });
  assert.equal(r.bucket, 'arriving_today');
  assert.equal(r.carrier, 'UPS');
  assert.equal(r.status, 'out_for_delivery');
});

test('classifyShipment buckets "delivered" with yesterday ts as arrived_yesterday', () => {
  const e = {
    content: 'Subject: Delivered — your Amazon order | From: shipment-tracking@amazon.com\n',
    ts: '2026-05-14T15:00:00Z',
    meta: { gmail_id: 'g2' },
  };
  const r = classifyShipment(e, {
    todayStr: '2026-05-15',
    yesterdayStr: '2026-05-14',
    tomorrowStr: '2026-05-16',
  });
  assert.equal(r.bucket, 'arrived_yesterday');
  assert.equal(r.carrier, 'Amazon');
});

test('classifyShipment returns null for non-shipment mail', () => {
  const e = {
    content: 'Subject: 50% off your next order — sale ends today | From: promo@store.com\n',
    ts: '2026-05-15T10:00:00Z',
    meta: { gmail_id: 'g3' },
  };
  const r = classifyShipment(e, {
    todayStr: '2026-05-15',
    yesterdayStr: '2026-05-14',
    tomorrowStr: '2026-05-16',
  });
  assert.equal(r, null);
});

test('classifyShipment skips marketing emails that mention "ship"', () => {
  const e = {
    content: 'Subject: Free shipping promo — 20% off | From: marketing@retailer.com\n',
    ts: '2026-05-15T10:00:00Z',
    meta: { gmail_id: 'g4' },
  };
  const r = classifyShipment(e, {
    todayStr: '2026-05-15',
    yesterdayStr: '2026-05-14',
    tomorrowStr: '2026-05-16',
  });
  assert.equal(r, null);
});

test('gmail_shipments tool buckets multiple events and dedupes', async () => {
  const db = await fresh();
  const seeds = [
    {
      source: 'gmail',
      content: 'Subject: Out for delivery — order #99 | From: UPS <noreply@ups.com>\nETA today.',
      ts: new Date(),
      meta: { gmail_id: 'a' },
    },
    {
      // Duplicate dispatch from the same carrier+item should collapse.
      source: 'gmail',
      content: 'Subject: Out for delivery — order #99 | From: UPS <noreply@ups.com>\nETA today.',
      ts: new Date(Date.now() - 60_000),
      meta: { gmail_id: 'b' },
    },
    {
      source: 'gmail',
      content: 'Subject: Delivered — your B&H order | From: orders@bhphotovideo.com\n',
      ts: new Date(Date.now() - 86_400_000),
      meta: { gmail_id: 'c' },
    },
    {
      source: 'gmail',
      content:
        'Subject: Newsletter — products you may like | From: marketing@store.com\nDiscount inside.',
      ts: new Date(),
      meta: { gmail_id: 'd' },
    },
  ];
  for (const s of seeds) {
    await db.query(surql`CREATE events CONTENT ${s}`).collect();
  }
  const t = createGmailShipmentsTool({ db });
  const r = await t.handler({ days_back: 7 });
  assert.equal(r.arriving_today.length, 1);
  assert.equal(r.arriving_today[0].carrier, 'UPS');
  assert.equal(r.arrived_yesterday.length, 1);
  assert.equal(r.arrived_yesterday[0].carrier, 'B&H');
  await close(db);
});

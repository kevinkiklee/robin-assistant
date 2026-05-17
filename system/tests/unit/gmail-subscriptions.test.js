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
  aggregateSubscriptions,
  classifyReceipt,
  createGmailSubscriptionsTool,
} from '../../io/integrations/gmail/tools/gmail-subscriptions.js';

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

function eventAt(daysAgo, { subject, from, snippet = '' }) {
  return {
    source: 'gmail',
    content: `Subject: ${subject} | From: ${from}\n${snippet}`,
    ts: new Date(Date.now() - daysAgo * 86_400_000),
    meta: { gmail_id: `g-${daysAgo}-${subject.slice(0, 8)}` },
  };
}

test('classifyReceipt extracts amount and sender domain', () => {
  const r = classifyReceipt({
    content: 'Subject: Your Spotify Premium receipt — $10.99 | From: receipts@spotify.com\n',
    ts: '2026-05-15T10:00:00Z',
  });
  assert.equal(r.domain, 'spotify.com');
  assert.equal(r.amount, 10.99);
});

test('classifyReceipt skips promotional emails even with prices', () => {
  const r = classifyReceipt({
    content: 'Subject: Save $20 off your next order | From: marketing@store.com\n',
    ts: '2026-05-15T10:00:00Z',
  });
  assert.equal(r, null);
});

test('classifyReceipt parses amount from snippet when subject lacks it', () => {
  const r = classifyReceipt({
    content:
      'Subject: Your invoice from Acme | From: billing@acme.io\nThanks for your payment of $42.00.',
    ts: '2026-05-15T10:00:00Z',
  });
  assert.equal(r.amount, 42);
});

test('classifyReceipt returns null without an amount', () => {
  const r = classifyReceipt({
    content: 'Subject: Your subscription is active | From: hi@service.io\nWelcome aboard.',
    ts: '2026-05-15T10:00:00Z',
  });
  assert.equal(r, null);
});

test('aggregateSubscriptions infers monthly cadence from ~30d-spaced charges', () => {
  const receipts = [0, 30, 60, 90].map((d) => ({
    domain: 'netflix.com',
    from: 'info@netflix.com',
    amount: 15.49,
    ts: new Date(Date.now() - d * 86_400_000).toISOString(),
    subject: 'Receipt',
  }));
  const subs = aggregateSubscriptions(receipts, { now: new Date() });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].cadence, 'monthly');
  assert.equal(subs[0].charge_count, 4);
});

test('aggregateSubscriptions detects price change across amount buckets', () => {
  const receipts = [
    ...[180, 150, 120].map((d) => ({
      domain: 'figma.com',
      from: 'billing@figma.com',
      amount: 12,
      ts: new Date(Date.now() - d * 86_400_000).toISOString(),
      subject: 'Receipt',
    })),
    ...[90, 60, 30, 0].map((d) => ({
      domain: 'figma.com',
      from: 'billing@figma.com',
      amount: 15,
      ts: new Date(Date.now() - d * 86_400_000).toISOString(),
      subject: 'Receipt',
    })),
  ];
  const subs = aggregateSubscriptions(receipts, { now: new Date() });
  const current = subs.find((s) => s.amount === 15);
  assert.ok(current.price_change);
  assert.equal(current.price_change.from, 12);
  assert.equal(current.price_change.to, 15);
  assert.equal(current.price_change.delta_pct, 25);
});

test('aggregateSubscriptions ignores single charges', () => {
  const receipts = [
    {
      domain: 'oneoffshop.com',
      from: 'orders@oneoffshop.com',
      amount: 200,
      ts: new Date().toISOString(),
      subject: 'Order receipt',
    },
  ];
  const subs = aggregateSubscriptions(receipts, { now: new Date() });
  assert.equal(subs.length, 0);
});

test('aggregateSubscriptions flags new-in-window subscriptions', () => {
  const receipts = [0, 30].map((d) => ({
    domain: 'newservice.com',
    from: 'billing@newservice.com',
    amount: 9.99,
    ts: new Date(Date.now() - d * 86_400_000).toISOString(),
    subject: 'Receipt',
  }));
  const subs = aggregateSubscriptions(receipts, { now: new Date(), newSinceDays: 60 });
  assert.equal(subs[0].is_new, true);
});

test('aggregateSubscriptions classifies annual cadence', () => {
  const receipts = [0, 365].map((d) => ({
    domain: '1password.com',
    from: 'receipts@1password.com',
    amount: 60,
    ts: new Date(Date.now() - d * 86_400_000).toISOString(),
    subject: 'Annual subscription',
  }));
  const subs = aggregateSubscriptions(receipts, { now: new Date() });
  assert.equal(subs[0].cadence, 'annual');
});

test('gmail_subscriptions tool aggregates and totals across events', async () => {
  const db = await fresh();
  const seeds = [
    ...[0, 30, 60, 90].map((d) =>
      eventAt(d, {
        subject: 'Your Spotify Premium receipt — $10.99',
        from: 'receipts@spotify.com',
      }),
    ),
    ...[0, 365].map((d) =>
      eventAt(d, {
        subject: 'Your 1Password annual subscription — $60.00',
        from: 'receipts@1password.com',
      }),
    ),
    eventAt(5, {
      subject: 'Save 50% on new arrivals',
      from: 'marketing@store.com',
    }),
    eventAt(2, {
      subject: 'Thanks for your $200 order',
      from: 'orders@oneoff.com',
    }),
  ];
  for (const s of seeds) {
    await db.query(surql`CREATE events CONTENT ${s}`).collect();
  }
  const t = createGmailSubscriptionsTool({ db });
  const r = await t.handler({ days_back: 400 });
  assert.equal(r.count, 2);
  const services = r.subscriptions.map((s) => s.service).sort();
  assert.deepEqual(services, ['1password.com', 'spotify.com']);
  // Monthly total ≈ 10.99 + 60/12 = 15.99
  assert.ok(r.monthly_total_estimated >= 15.9 && r.monthly_total_estimated <= 16.1);
  await close(db);
});

test('gmail_subscriptions tool honors min_monthly filter', async () => {
  const db = await fresh();
  const seeds = [
    ...[0, 30, 60].map((d) => eventAt(d, { subject: 'Receipt — $2.99', from: 'billing@cheap.io' })),
    ...[0, 30, 60].map((d) =>
      eventAt(d, { subject: 'Receipt — $50.00', from: 'billing@expensive.io' }),
    ),
  ];
  for (const s of seeds) {
    await db.query(surql`CREATE events CONTENT ${s}`).collect();
  }
  const t = createGmailSubscriptionsTool({ db });
  const r = await t.handler({ days_back: 90, min_monthly: 10 });
  assert.equal(r.count, 1);
  assert.equal(r.subscriptions[0].service, 'expensive.io');
  await close(db);
});

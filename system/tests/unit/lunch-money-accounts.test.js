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
  accountToEvent,
  accountToSnapshotEvent,
} from '../../io/integrations/lunch_money/client.js';
import { createLunchMoneyAccountsTool } from '../../io/integrations/lunch_money/tools/lunch-money-accounts.js';

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

test('accountToEvent shapes a plaid checking row', () => {
  const e = accountToEvent(
    {
      id: 42,
      display_name: 'Chase Checking',
      institution_name: 'Chase',
      type: 'depository',
      subtype: 'checking',
      balance: '1234.56',
      balance_as_of: '2026-05-15T00:00:00Z',
      currency: 'usd',
      status: 'active',
    },
    { kind: 'plaid' },
  );
  assert.equal(e.source, 'lunch_money_account');
  assert.equal(e.external_id, 'lm_account:plaid:42');
  assert.equal(e.meta.balance, 1234.56);
  assert.equal(e.meta.kind, 'plaid');
  assert.equal(e.meta.institution, 'Chase');
  assert.match(e.content, /Chase Checking/);
});

test('accountToEvent flags closed accounts as excluded_from_totals', () => {
  const e = accountToEvent(
    { id: 9, name: 'Old Card', type: 'credit', balance: '0', status: 'closed' },
    { kind: 'plaid' },
  );
  assert.equal(e.meta.excluded_from_totals, true);
});

test('accountToSnapshotEvent has date-suffixed external_id for daily upsert', () => {
  const e = accountToSnapshotEvent(
    {
      id: 42,
      display_name: 'Chase Checking',
      type: 'depository',
      subtype: 'checking',
      balance: '1234.56',
    },
    { kind: 'plaid', dateStr: '2026-05-15' },
  );
  assert.equal(e.source, 'lunch_money_account_snapshot');
  assert.equal(e.external_id, 'lm_account_snap:plaid:42:2026-05-15');
  assert.equal(e.meta.snapshot_date, '2026-05-15');
  assert.equal(e.meta.balance, 1234.56);
});

test('accountToEvent uses to_base when present (LM USD conversion)', () => {
  const e = accountToEvent(
    { id: 1, name: 'EU Account', balance: '100.00', to_base: '108.50', currency: 'eur' },
    { kind: 'asset' },
  );
  assert.equal(e.meta.balance, 108.5);
});

test('lunch_money_accounts groups + computes net_position', async () => {
  const db = await fresh();
  const seeds = [
    {
      source: 'lunch_money_account',
      content: 'Chase Checking · $5000 · depository/checking',
      ts: new Date(),
      meta: {
        kind: 'plaid',
        type: 'depository',
        subtype: 'checking',
        balance: 5000,
        excluded_from_totals: false,
      },
    },
    {
      source: 'lunch_money_account',
      content: 'Ally HYSA · $20000 · depository/savings',
      ts: new Date(),
      meta: {
        kind: 'plaid',
        type: 'depository',
        subtype: 'savings',
        balance: 20000,
        excluded_from_totals: false,
      },
    },
    {
      source: 'lunch_money_account',
      content: 'Chase Card · $1500 · credit',
      ts: new Date(),
      meta: { kind: 'plaid', type: 'credit', balance: 1500, excluded_from_totals: false },
    },
    {
      source: 'lunch_money_account',
      content: 'Fidelity 401k · $80000 · investment/401k',
      ts: new Date(),
      meta: {
        kind: 'plaid',
        type: 'investment',
        subtype: '401k',
        balance: 80000,
        excluded_from_totals: false,
      },
    },
    {
      source: 'lunch_money_account',
      content: 'Closed card · $0 · credit',
      ts: new Date(),
      meta: { kind: 'plaid', type: 'credit', balance: 0, excluded_from_totals: true },
    },
  ];
  for (const s of seeds) {
    await db.query(surql`CREATE events CONTENT ${s}`).collect();
  }
  const t = createLunchMoneyAccountsTool({ db });
  const r = await t.handler({});
  // depository (savings + checking) → liquid; credit → debt; investment → investment.
  // Closed card excluded.
  assert.equal(r.liquid_total, 25000);
  assert.equal(r.debt_total, 1500);
  assert.equal(r.investment_total, 80000);
  assert.equal(r.net_position, 23500);
  assert.equal(r.accounts.length, 4);
  await close(db);
});

test('lunch_money_accounts include_excluded surfaces closed accounts', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money_account',
        content: 'Closed · $0',
        ts: new Date(),
        meta: { type: 'credit', balance: 0, excluded_from_totals: true },
      }}`,
    )
    .collect();
  const t = createLunchMoneyAccountsTool({ db });
  const r = await t.handler({ include_excluded: true });
  assert.equal(r.accounts.length, 1);
  await close(db);
});

test('lunch_money_accounts bucket filter narrows results', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money_account',
        content: 'Cash · $100',
        ts: new Date(),
        meta: { type: 'cash', balance: 100, excluded_from_totals: false },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'lunch_money_account',
        content: 'Card · $50',
        ts: new Date(),
        meta: { type: 'credit', balance: 50, excluded_from_totals: false },
      }}`,
    )
    .collect();
  const t = createLunchMoneyAccountsTool({ db });
  const r = await t.handler({ bucket: 'liquid' });
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].bucket, 'liquid');
  await close(db);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policiesSchema } from './schema.ts';

test('policiesSchema: applies agent block defaults when absent', () => {
  const p = policiesSchema.parse({});
  assert.equal(p.agent.enabled, false); // opt-in: agentic runs cost real money
  assert.equal(p.agent.caps.agentic_on_demand_daily_usd, 50);
  assert.equal(p.agent.caps.agentic_autonomous_daily_usd, 25);
  assert.equal(p.agent.session.default_model, 'claude-sonnet-4-6');
  assert.equal(p.agent.session.default_max_turns, 30);
  assert.equal(p.agent.session.default_timeout_ms, 1_800_000);
  assert.equal(p.agent.session.default_max_budget_usd, 5);
  assert.equal(p.agent.write.file_checkpointing, true);
  assert.equal(p.agent.credit.notify_on_exhaustion, true);
  assert.equal(p.agent.bill_to_pool, true);
});

test('policiesSchema: merges partial agent overrides with defaults', () => {
  const p = policiesSchema.parse({
    agent: {
      enabled: true, // override the opt-in default off
      caps: { agentic_on_demand_daily_usd: 10 },
      session: { default_max_turns: 5 },
    },
  });
  assert.equal(p.agent.enabled, true);
  assert.equal(p.agent.caps.agentic_on_demand_daily_usd, 10);
  // Sibling default preserved within a partially-specified sub-object.
  assert.equal(p.agent.caps.agentic_autonomous_daily_usd, 25);
  assert.equal(p.agent.session.default_max_turns, 5);
  assert.equal(p.agent.session.default_model, 'claude-sonnet-4-6');
});

test('policiesSchema: still applies the other block defaults', () => {
  const p = policiesSchema.parse({});
  assert.equal(p.power.state, 'active');
  assert.equal(p.notifications.health, true);
});

test('policiesSchema: defaults alerts.staleness to {} when the block is absent', () => {
  // Existing policies.yaml files have no `alerts` key — they must still parse,
  // with an empty staleness map (no per-integration overrides).
  const p = policiesSchema.parse({});
  assert.deepEqual(p.alerts.staleness, {});
});

test('policiesSchema: keeps per-integration staleness overrides', () => {
  const p = policiesSchema.parse({
    alerts: {
      staleness: {
        whoop: { exempt: true },
        spotify: { warn_multiplier: 5, critical_multiplier: 20 },
      },
    },
  });
  assert.equal(p.alerts.staleness.whoop.exempt, true);
  assert.equal(p.alerts.staleness.spotify.warn_multiplier, 5);
  assert.equal(p.alerts.staleness.spotify.critical_multiplier, 20);
});

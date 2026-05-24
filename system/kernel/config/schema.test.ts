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

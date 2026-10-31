import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelsSchema, policiesSchema } from './schema.ts';

test('policiesSchema: applies agent block defaults when absent', () => {
  const p = policiesSchema.parse({});
  assert.equal(p.agent.enabled, false); // opt-in: agentic runs cost real money
  assert.equal(p.agent.caps.agentic_on_demand_daily_usd, 50);
  assert.equal(p.agent.caps.agentic_autonomous_daily_usd, 25);
  assert.equal(p.agent.session.default_model, 'claude-sonnet-5-5');
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
  assert.equal(p.agent.session.default_model, 'claude-sonnet-5-5');
});

test('policiesSchema: still applies the other block defaults', () => {
  const p = policiesSchema.parse({});
  assert.equal(p.power.state, 'active');
  assert.equal(p.notifications.health, true);
});

test('policiesSchema: applies scouts block defaults when absent', () => {
  const p = policiesSchema.parse({});
  assert.equal(p.scouts.enabled, true); // master switch ON by default
  assert.equal(p.scouts.finance, true);
  assert.equal(p.scouts.health, true);
  assert.equal(p.scouts.travel, true);
  assert.equal(p.scouts.career, true);
  assert.equal(p.scouts.social, true);
});

test('policiesSchema: merges partial scouts overrides with defaults', () => {
  const p = policiesSchema.parse({ scouts: { health: false } });
  assert.equal(p.scouts.health, false);
  // Master switch and sibling domains keep their defaults.
  assert.equal(p.scouts.enabled, true);
  assert.equal(p.scouts.finance, true);
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

test('modelsSchema: a role accepts an optional SDK effort (primary + fallback), rejects junk', () => {
  const m = modelsSchema.parse({
    roles: {
      classify: {
        provider: 'claude-agent',
        model: 'claude-sonnet-4-6',
        effort: 'low',
        fallback: { provider: 'claude-agent', model: 'claude-opus-4-8', effort: 'low' },
      },
      reasoning: { provider: 'claude-agent', model: 'claude-sonnet-4-6' },
    },
  });
  assert.equal(m.roles.classify?.effort, 'low');
  assert.equal(m.roles.classify?.fallback?.effort, 'low');
  assert.equal(m.roles.reasoning?.effort, undefined, 'unset stays unset (SDK default)');
  assert.throws(() =>
    modelsSchema.parse({ roles: { classify: { provider: 'claude-agent', effort: 'turbo' } } }),
  );
});

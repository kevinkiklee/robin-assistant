import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confidenceForDecay,
  detectRuleKind,
  entityTypeForKnowledgePath,
  PERSONA_FACET_MAP,
} from '../../../runtime/install/v1-import/taxonomy.js';

test('entityTypeForKnowledgePath: maps subdir prefixes', () => {
  assert.equal(entityTypeForKnowledgePath('service-providers/bh-photo.md'), 'service');
  assert.equal(entityTypeForKnowledgePath('locations/home.md'), 'place');
  assert.equal(entityTypeForKnowledgePath('projects/photobot.md'), 'project');
  assert.equal(entityTypeForKnowledgePath('events/wedding.md'), 'event');
});

test('entityTypeForKnowledgePath: defaults unknown subdirs to concept', () => {
  assert.equal(entityTypeForKnowledgePath('medical/back-spine.md'), 'concept');
  assert.equal(entityTypeForKnowledgePath('finance/lunch-money/INDEX.md'), 'concept');
});

test('entityTypeForKnowledgePath: flatfile at knowledge/ root is concept', () => {
  assert.equal(entityTypeForKnowledgePath('recipes.md'), 'concept');
});

test('confidenceForDecay: pinned values', () => {
  assert.equal(confidenceForDecay('slow'), 0.9);
  assert.equal(confidenceForDecay('medium'), 0.7);
  assert.equal(confidenceForDecay('fast'), 0.5);
  assert.equal(confidenceForDecay('immortal'), 1.0);
});

test('confidenceForDecay: unknown falls back to default', () => {
  assert.equal(confidenceForDecay(undefined), 0.7);
  assert.equal(confidenceForDecay('nonsense'), 0.7);
});

test('detectRuleKind: profile_update for naming preferences', () => {
  assert.equal(detectRuleKind('Refer to umma as Mom'), 'profile_update');
  assert.equal(detectRuleKind('Call Kevin\'s brother as Joony'), 'profile_update');
});

test('detectRuleKind: defaults to behavior', () => {
  assert.equal(detectRuleKind('Be terse and direct in responses.'), 'behavior');
  assert.equal(detectRuleKind('Always run tests before committing.'), 'behavior');
});

test('PERSONA_FACET_MAP: identity projector extracts name and pronouns', () => {
  const body = '- **Name:** Kevin K Lee\n- **Pronouns:** he/him\n- something else';
  const proj = PERSONA_FACET_MAP.identity(body);
  assert.equal(proj.name, 'Kevin K Lee');
  assert.equal(proj.pronouns, 'he/him');
});

test('PERSONA_FACET_MAP: comm_style projectors stash body under facet slug', () => {
  const proj = PERSONA_FACET_MAP.personality('terse responses preferred', null, {
    facet_slug: 'personality',
  });
  assert.equal(typeof proj.comm_style, 'object');
  assert.match(proj.comm_style.personality, /terse responses/);
});

test('PERSONA_FACET_MAP: interests projector pulls top-level bullets as tags', () => {
  const body = '- **Photography:** lots\n- Birding\n- Korean food\n';
  const proj = PERSONA_FACET_MAP.interests(body);
  assert.ok(Array.isArray(proj.interests));
  assert.ok(proj.interests.length >= 1);
  assert.ok(proj.interests.every((t) => typeof t === 'string'));
});

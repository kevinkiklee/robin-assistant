import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_EMBED_KINDS, deniedKindSql, embeddableKindSql, shouldEmbed } from './embed-policy.ts';

test('embeds high-value recall kinds', () => {
  assert.equal(shouldEmbed('knowledge.doc'), true);
  assert.equal(shouldEmbed('belief.update'), true);
  assert.equal(shouldEmbed('conversation.claude-code'), true);
  assert.equal(shouldEmbed('photos.critique'), true);
  assert.equal(shouldEmbed('biographer.extracted'), true);
});

test('skips operational ack kinds', () => {
  assert.equal(shouldEmbed('invariant.check'), false);
  assert.equal(shouldEmbed('daemon.start'), false);
  assert.equal(shouldEmbed('daemon.shutdown'), false);
});

test('skips any *.tick kind via suffix rule', () => {
  assert.equal(shouldEmbed('integration.tick'), false);
  assert.equal(shouldEmbed('integration.finance_quote.tick'), false);
  assert.equal(shouldEmbed('some.future.tick'), false);
});

test('skips high-volume low-value integration records', () => {
  assert.equal(shouldEmbed('lunch_money.transaction'), false);
  assert.equal(shouldEmbed('lunch_money.account_snapshot'), false);
  assert.equal(shouldEmbed('v2.lunch_money'), false);
  assert.equal(shouldEmbed('spotify_played'), false);
  assert.equal(shouldEmbed('spotify_top_track'), false);
  assert.equal(shouldEmbed('spotify_top_artist'), false);
  assert.equal(shouldEmbed('v2.spotify'), false);
  assert.equal(shouldEmbed('integration.chrome.visit'), false);
});

test('NO_EMBED_KINDS membership matches shouldEmbed for exact kinds', () => {
  for (const kind of NO_EMBED_KINDS) {
    assert.equal(shouldEmbed(kind), false, `${kind} should not embed`);
  }
});

test('embeddableKindSql produces a predicate that excludes denied + .tick kinds', () => {
  const { sql, params } = embeddableKindSql('e.kind');
  // The predicate references the column and a .tick guard; params cover the exact denylist.
  assert.match(sql, /e\.kind NOT IN/);
  assert.match(sql, /NOT LIKE '%\.tick'/);
  assert.deepEqual(new Set(params), new Set(NO_EMBED_KINDS));
});

test('deniedKindSql is the logical inverse of embeddableKindSql', () => {
  const { sql, params } = deniedKindSql('e.kind');
  assert.match(sql, /e\.kind IN/);
  assert.match(sql, /LIKE '%\.tick'/);
  assert.doesNotMatch(sql, /NOT IN/);
  assert.deepEqual(new Set(params), new Set(NO_EMBED_KINDS));
});

// tests/unit/scope-registry.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isEphemeral,
  isHierarchical,
  isOutboundBlocked,
  persistentScopesSqlFilter,
  policyFor,
  scopeMatches,
  ttlDays,
  validateScope,
} from '../../cognition/memory/scope-registry.js';

test('policyFor: exact matches', () => {
  assert.equal(policyFor('global').outbound, 'allow');
  assert.equal(policyFor('global').ephemeral, false);
  assert.equal(policyFor('private').outbound, 'block');
});

test('policyFor: prefix matches', () => {
  assert.equal(policyFor('project:robin').lifetime, 'persistent');
  assert.equal(policyFor('project:robin/v2/x').hierarchical, true);
  assert.equal(policyFor('session:abc123').ttl_days, 7);
  assert.equal(policyFor('temp:bash-out').ttl_days, 1);
  assert.equal(policyFor('integration:gmail').ephemeral, false);
});

test('policyFor: unknown returns safe default (not throw)', () => {
  const p = policyFor('legacy:weird');
  assert.equal(p.lifetime, 'persistent');
  assert.equal(p.outbound, 'allow');
  assert.equal(p.ephemeral, false);
});

test('predicates', () => {
  assert.equal(isEphemeral('session:x'), true);
  assert.equal(isEphemeral('temp:y'), true);
  assert.equal(isEphemeral('project:z'), false);
  assert.equal(isOutboundBlocked('private'), true);
  assert.equal(isOutboundBlocked('global'), false);
  assert.equal(isHierarchical('project:robin'), true);
  assert.equal(isHierarchical('integration:gmail'), false);
  assert.equal(ttlDays('session:x'), 7);
  assert.equal(ttlDays('global'), null);
});

test('validateScope accepts known patterns', () => {
  assert.equal(validateScope('global'), 'global');
  assert.equal(validateScope('private'), 'private');
  assert.equal(validateScope('project:robin/v2/theme-1c'), 'project:robin/v2/theme-1c');
  assert.equal(validateScope('session:abc'), 'session:abc');
});

test('validateScope rejects unknown / empty', () => {
  assert.throws(() => validateScope('projeect:typo'), /unknown pattern/);
  assert.throws(() => validateScope(''), /empty/);
  assert.throws(() => validateScope(null), /empty/);
});

test('scopeMatches: descendant + exact + sibling-reject', () => {
  assert.equal(scopeMatches('project:robin', 'project:robin'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin/v2'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin/v2/theme-1c'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin-other'), false);
  assert.equal(scopeMatches('project:robin/v2', 'project:robin'), false);
});

test('persistentScopesSqlFilter contains all persistent scope clauses', () => {
  const sql = persistentScopesSqlFilter();
  assert.match(sql, /scope = 'global'/);
  assert.match(sql, /scope = 'private'/);
  assert.match(sql, /string::starts_with\(scope, 'project:'\)/);
  assert.match(sql, /string::starts_with\(scope, 'integration:'\)/);
  // ephemerals must not appear
  assert.doesNotMatch(sql, /'session:'/);
  assert.doesNotMatch(sql, /'temp:'/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ConsentParams, consentPage } from './consent.ts';
import { decisionForm, parseForms, submitForm } from './test-helpers.ts';

const PARAMS: ConsentParams = {
  clientId: 'abc123',
  clientName: 'Claude',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  state: 'xyz',
  resource: 'https://mcp.example.test/mcp',
  scope: 'robin:read',
};

test('consent: the write checkbox belongs to the form that posts the decision', () => {
  const html = consentPage(PARAMS);
  const form = decisionForm(html);
  const box = form.controls.find((c) => c.name === 'grant_write');
  // A checkbox outside the form (and without form=) is never submitted by a
  // browser, so write scope could not be granted from the UI at all.
  assert.ok(box, 'grant_write must be owned by the POST /oauth/authorize form');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.value, '1', 'the server grants write only on grant_write=1');

  // Every grant_write control on the page must be that one — no stray copy that
  // a browser would silently drop.
  const owned = parseForms(html).flatMap((f) => f.controls.filter((c) => c.name === 'grant_write'));
  assert.equal(owned.length, 1);
  const total = html.match(/name="grant_write"/g)?.length ?? 0;
  assert.equal(total, 1, 'no grant_write control may sit outside every form');
});

test('consent: ticking the box submits grant_write=1 alongside the flow parameters', () => {
  const form = decisionForm(consentPage(PARAMS));
  const ticked = submitForm(form, { filled: { access_key: 'k' }, checked: ['grant_write'] });
  assert.equal(ticked.get('grant_write'), '1');
  assert.equal(ticked.get('client_id'), PARAMS.clientId);
  assert.equal(ticked.get('redirect_uri'), PARAMS.redirectUri);
  assert.equal(ticked.get('access_key'), 'k');

  const unticked = submitForm(form, { filled: { access_key: 'k' } });
  assert.equal(unticked.get('grant_write'), null, 'an unticked box submits nothing');
});

test('consent: the client name and redirect host are shown prominently', () => {
  const html = consentPage(PARAMS);
  assert.match(html, /<strong class="client">Claude<\/strong>/);
  assert.match(html, /<strong class="host">claude\.ai<\/strong>/);
});

test('consent: an attacker-chosen client name and redirect are escaped', () => {
  const html = consentPage({
    ...PARAMS,
    clientName: '<script>alert(1)</script>"Claude"',
    redirectUri: 'http://localhost:8080/cb?x="><img src=x>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'client name must be escaped');
  assert.ok(!html.includes('<img src=x>'), 'redirect URI must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;Claude&quot;/);
  assert.match(html, /<strong class="host">localhost:8080<\/strong>/);
});

test('consent: a client that registered no name is labelled as such, not left blank', () => {
  const html = consentPage({ ...PARAMS, clientName: undefined });
  assert.match(html, /<strong class="client">an unnamed client<\/strong>/);
});

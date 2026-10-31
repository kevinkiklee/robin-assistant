import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInbound, checkOutbound, redactSecrets } from './policy.ts';

// Every token here is synthetic and assembled at runtime, so the source never
// carries a contiguous credential shape for gitleaks to flag.
const discordToken = (id: string) =>
  `${Buffer.from(id).toString('base64url')}.GhIjKl.${'aB3_-'.repeat(6)}`;

function assertCaught(text: string, label: string): void {
  const out = checkOutbound({ text });
  assert.equal(out.ok, false, `outbound should refuse ${label}: ${text}`);
  assert.ok(!out.ok && out.reason.startsWith('secret:'), label);
  assert.equal(checkInbound(text).ok, false, `inbound should refuse ${label}`);
  const r = redactSecrets(text);
  assert.ok(r.redacted >= 1, `redactSecrets should redact ${label}`);
}

function assertClean(text: string, label: string): void {
  assert.deepEqual(checkOutbound({ text }), { ok: true }, `outbound false positive: ${label}`);
  assert.deepEqual(checkInbound(text), { ok: true }, `inbound false positive: ${label}`);
  assert.equal(redactSecrets(text).redacted, 0, `redact false positive: ${label}`);
}

test('patterns: OpenAI project, service-account and admin keys', () => {
  for (const kind of ['proj', 'svcacct', 'admin']) {
    const key = `sk-${kind}-${'Ab3_-xY9'.repeat(5)}`;
    assertCaught(`export OPENAI=${key}`, `sk-${kind}`);
    assertCaught(`key ${key} in chat`, `sk-${kind} bare`);
    const r = checkOutbound({ text: `key ${key} in chat` });
    assert.equal(r.ok ? null : r.reason, 'secret:openai_scoped_key');
  }
});

test('patterns: env-style and JSON credential assignments', () => {
  const b64url = `Ab-_${'x9Y'.repeat(13)}`; // 43 chars, dash + underscore up front
  assert.equal(b64url.length, 43);
  assertCaught(`ROBIN_MCP_REMOTE_TOKEN=${b64url}`, 'unquoted base64url env value');
  assertCaught(`FOO_BAR=${b64url}`, 'base64url value under a non-secret name');
  // Values are assembled at runtime so the source holds no key-shaped literal
  // (gitleaks scans this file in CI).
  const v1 = ['a1B2c3D4', 'e5F6g7H8', 'i9J0k1'].join('');
  const v2 = ['q7W-e8R_', 't9Y0u1I2', 'o3P4a5'].join('');
  const v3 = ['q7We8Rt9', 'Y0u1I2o3', 'P4a5'].join('');
  assertCaught(`API_TOKEN="${v1}"`, 'double-quoted env value');
  assertCaught(`API_TOKEN='${v1}'`, 'single-quoted env value');
  assertCaught(`{"api_key": "${v2}"}`, 'JSON api_key');
  assertCaught(`const cfg = { clientSecret: '${v3}' };`, 'JS object secret');
  // Short passwords are an inbound-only rule (memory writes).
  assert.equal(checkInbound('{"password": "hunter2hunter2"}').ok, false);

  const r = redactSecrets(`before {"api_key": "${v2}"} after`);
  assert.doesNotMatch(r.text, /q7W-e8R/);
  assert.match(r.text, /^before .*REDACTED.* after$/);
});

test('patterns: bare Discord bot token', () => {
  assertCaught(`token ${discordToken('123456789012345678')} here`, '18-digit id');
  assertCaught(discordToken('1234567890123456789'), '19-digit id');
  assertCaught(discordToken('12345678901234567'), '17-digit id');
  assertCaught(discordToken('12345678901234567890'), '20-digit id');
  const r = checkOutbound({ text: discordToken('123456789012345678') });
  assert.equal(r.ok ? null : r.reason, 'secret:discord_bot_token');
});

test('patterns: Google OAuth access and refresh tokens', () => {
  assertCaught(`Bearer ya29.${'a0AfB_byC-'.repeat(3)}`, 'ya29 access token');
  assertCaught(`refresh 1//0${'gAbC-dEf_GhI'.repeat(2)}`, '1//0 refresh token');
});

test('patterns: vendor-prefixed tokens', () => {
  const cases: Array<[string, string]> = [
    ['linear_key', `lin_api_${'a1B2'.repeat(10)}`],
    ['huggingface_token', `hf_${'aB'.repeat(17)}`],
    ['npm_token', `npm_${'aB1'.repeat(12)}`],
    ['gitlab_pat', `glpat-${'aB1_-'.repeat(4)}`],
    ['supabase_token', `sbp_${'a1'.repeat(20)}`],
    ['notion_token', `ntn_${'aB1'.repeat(15)}`],
  ];
  for (const [name, token] of cases) {
    assertCaught(`use ${token} please`, name);
    const r = checkOutbound({ text: `use ${token} please` });
    assert.equal(r.ok ? null : r.reason, `secret:${name}`, name);
  }
});

// Deterministic pseudo-random bytes → standard base64, like an inline PNG.
function fakeImageBase64(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  let s = 0x2f6b1d3;
  for (let i = 0; i < bytes; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    buf[i] = s >>> 24;
  }
  return buf.toString('base64');
}

test('patterns: ordinary text, ids, markup and data are not credentials', () => {
  const cases: Array<[string, string]> = [
    ['prose', 'Baked bread at dawn, then reviewed the token budget and the API docs.'],
    ['git sha', 'commit fc12052e4b1d8a9c3f6e7b2a0d5c8e1f4a7b9c2d fixed it'],
    ['uuid', 'session 550e8400-e29b-41d4-a716-446655440000 resumed'],
    ['css colours', '.a{color:#FF00AA;background:#a1b2c3;border-color:#123456}'],
    [
      'url with query string',
      'https://example.com/search?q=hello+world&page=2&sort=desc&utm_campaign=fall_sale_2026_launch',
    ],
    ['svg path', '<path d="M120 35 L240 80 C10 20 30 40 50 60 Q90 12 300 400 Z"/>'],
    ['base64 image', `<img src="data:image/png;base64,${fakeImageBase64(6000)}">`],
    ['base64 with 1//0 inside', `data:image/png;base64,QUJD1//0${'AbCdEfGh'.repeat(4)}+/x==`],
    ['env reference in code', 'const token = process.env.DISCORD_BOT_TOKEN;'],
    ['token counts', '{"input_tokens": 12345678901234567890123, "max_tokens": 4096}'],
    ['quoted JS constant', "const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';"],
    ['quoted path constant', "const RUNNER_ENTRY = '/fake/system/agent/runner/index.js';"],
    ['kebab-case env value', 'GIT_BRANCH=feature-add-login-flow-for-users'],
    ['dotted hostname', 'MyVeryLongSubdomainNameXy.abcdef.someotherlongdomainpartnamehere'],
    ['underscore identifier', 'load hf_tokenizer_config_name and npm_package_version'],
    ['sk- prose', 'the sk-proj-setup doc'],
  ];
  for (const [label, text] of cases) assertClean(text, label);
});

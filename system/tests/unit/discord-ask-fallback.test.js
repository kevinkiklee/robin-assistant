import assert from 'node:assert';
import test from 'node:test';
import { isDiscordSession, renderAskAsText } from '../../io/integrations/discord/ask-fallback.js';

test('renderAskAsText numbers string options', () => {
  const out = renderAskAsText({
    question: 'Pick one:',
    options: ['Red', 'Green', 'Blue'],
  });
  assert.match(out, /^Pick one:/);
  assert.match(out, /1\. Red/);
  assert.match(out, /2\. Green/);
  assert.match(out, /3\. Blue/);
});

test('renderAskAsText includes option descriptions', () => {
  const out = renderAskAsText({
    question: 'Pick one:',
    options: [
      { label: 'Red', description: 'a warm color' },
      { label: 'Blue', description: 'a cool color' },
    ],
  });
  assert.match(out, /1\. Red — a warm color/);
  assert.match(out, /2\. Blue — a cool color/);
});

test('isDiscordSession reads ROBIN_SESSION_PLATFORM env var', () => {
  const prev = process.env.ROBIN_SESSION_PLATFORM;
  process.env.ROBIN_SESSION_PLATFORM = 'discord';
  assert.strictEqual(isDiscordSession(), true);
  process.env.ROBIN_SESSION_PLATFORM = 'terminal';
  assert.strictEqual(isDiscordSession(), false);
  delete process.env.ROBIN_SESSION_PLATFORM;
  assert.strictEqual(isDiscordSession(), false);
  if (prev) process.env.ROBIN_SESSION_PLATFORM = prev;
});

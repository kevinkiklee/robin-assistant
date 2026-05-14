import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLLMJSON } from '../../cognition/biographer/output.js';

test('parses raw JSON without fences', () => {
  const o = parseLLMJSON('{"events":[]}');
  assert.deepEqual(o, { events: [] });
});

test('parses ```json-fenced content', () => {
  const o = parseLLMJSON('```json\n{"events":[]}\n```');
  assert.deepEqual(o, { events: [] });
});

test('parses plain ```-fenced content (no json hint)', () => {
  const o = parseLLMJSON('```\n{"events":[1]}\n```');
  assert.deepEqual(o, { events: [1] });
});

test('parses JSON with prose preamble before fence', () => {
  // Most common chat-model failure: "Here's the JSON:\n\n```json\n...```"
  const o = parseLLMJSON('Here is the JSON:\n\n```json\n{"events":[{"id":"x"}]}\n```');
  assert.deepEqual(o, { events: [{ id: 'x' }] });
});

test('parses JSON with prose trailing after fence', () => {
  const o = parseLLMJSON('```json\n{"events":[]}\n```\n\nLet me know if adjustments are needed.');
  assert.deepEqual(o, { events: [] });
});

test('parses unfenced JSON with prose preamble', () => {
  // Model emits raw JSON but with a conversational preface.
  const o = parseLLMJSON('Sure! Here you go:\n{"events":[{"id":"a"}]}');
  assert.deepEqual(o, { events: [{ id: 'a' }] });
});

test('parses unfenced JSON with prose trailing', () => {
  const o = parseLLMJSON('{"events":[]}\n\nThat\'s the output.');
  assert.deepEqual(o, { events: [] });
});

test('parses second fenced block when first is non-JSON reasoning', () => {
  const content = '```\nLet me think through this.\n```\n\n```json\n{"events":[]}\n```';
  const o = parseLLMJSON(content);
  assert.deepEqual(o, { events: [] });
});

test('empty content throws a clear empty-content error', () => {
  assert.throws(() => parseLLMJSON(''), /empty/i);
  assert.throws(() => parseLLMJSON('   \n  '), /empty/i);
  assert.throws(() => parseLLMJSON(null), /empty/i);
});

test('truncated JSON throws a clear truncation error mentioning max_tokens', () => {
  // Simulates the model hitting max_tokens mid-stream: no closing brace.
  const truncated = '```json\n{"events":[{"event_id":"e:1","entities":[{"name":"X","type":"per';
  assert.throws(() => parseLLMJSON(truncated), /truncat|max_tokens/i);
});

test('content with no JSON object at all throws a clear error', () => {
  assert.throws(() => parseLLMJSON('I cannot complete this task.'), /no JSON/i);
});

test('preserves braces inside JSON string values', () => {
  // Edge case: a string field contains `}` which must not close the outer object early.
  const content = 'Preamble.\n{"events":[{"summary":"close the } brace"}]}';
  const o = parseLLMJSON(content);
  assert.equal(o.events[0].summary, 'close the } brace');
});

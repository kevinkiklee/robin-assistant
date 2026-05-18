// system/tests/unit/mcp-session-id-threading.test.js
//
// Verifies that getSessionId() returns the correct transport.sessionId inside
// a tool handler dispatch, and null outside of one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { als, getSessionId } from '../../../system/runtime/mcp/current-call.js';

describe('mcp session-id threading (AsyncLocalStorage)', () => {
  it('getSessionId() returns null outside an MCP call', () => {
    assert.strictEqual(getSessionId(), null);
  });

  it('getSessionId() returns the sessionId set by als.run()', async () => {
    const expected = 'test-session-abc123';
    let captured;

    await als.run({ sessionId: expected }, async () => {
      // Simulate async work (as a real tool handler would do)
      await Promise.resolve();
      captured = getSessionId();
    });

    assert.strictEqual(captured, expected);
  });

  it('getSessionId() is null again after als.run() resolves', async () => {
    await als.run({ sessionId: 'ephemeral' }, async () => {
      // inside
    });
    assert.strictEqual(getSessionId(), null);
  });

  it('nested als.run() scopes are isolated', async () => {
    const outer = 'outer-session';
    const inner = 'inner-session';
    let outerCapture;
    let innerCapture;

    await als.run({ sessionId: outer }, async () => {
      outerCapture = getSessionId();
      await als.run({ sessionId: inner }, async () => {
        innerCapture = getSessionId();
      });
      // Outer context restored after inner run
      assert.strictEqual(getSessionId(), outer);
    });

    assert.strictEqual(outerCapture, outer);
    assert.strictEqual(innerCapture, inner);
  });

  it('concurrent als.run() calls do not bleed session IDs', async () => {
    const results = [];

    await Promise.all(
      ['session-A', 'session-B', 'session-C'].map((id) =>
        als.run({ sessionId: id }, async () => {
          // Yield to let other concurrent contexts progress
          await Promise.resolve();
          results.push({ id, got: getSessionId() });
        }),
      ),
    );

    for (const { id, got } of results) {
      assert.strictEqual(got, id, `session ${id} got wrong id: ${got}`);
    }
  });

  it('models the mcp-sse.js CallToolRequestSchema dispatch pattern', async () => {
    // Simulate how mcp-sse.js wraps each tool.handler(args) call:
    //   return als.run({ sessionId: transport.sessionId }, async () => {
    //     const result = await tool.handler(args ?? {});
    //     ...
    //   });

    const transportSessionId = 'transport-session-xyz';

    const toolHandler = async (_args) => {
      // Inside the handler, getSessionId() must return the transport's id
      return { sessionIdSeen: getSessionId() };
    };

    const result = await als.run({ sessionId: transportSessionId }, async () => {
      return toolHandler({});
    });

    assert.strictEqual(result.sessionIdSeen, transportSessionId);
  });
});

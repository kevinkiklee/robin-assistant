// system/tests/lib/stubs.js
//
// Outbound call stubs for the e2e harness.
//
// Surface covered in v1: globalThis.fetch only.
//
// Not covered in v1:
//   - node:child_process.spawn / spawnSync — the imported namespace is
//     immutable per ES module spec (TypeError on reassignment). Spawn
//     stubbing requires either an ESM loader (--import / module.register)
//     or migrating Robin's spawn callers to a wrapper module that the
//     harness can patch. Deferred to a future phase.
//   - node:http.request / https.request / net.connect — Robin's outbound
//     traffic goes through fetch today; if a future Robin path uses raw
//     http/net, extend this module.
//
// Block-by-default: any unmatched fetch call records a `block` event and
// throws NetworkBlockedError. The harness orchestrator (scenario.js)
// fails the scenario if the ledger contains any block events at scenario
// end, regardless of whether the throw was caught by Robin's code.

const realFetch = globalThis.fetch;

let state = null; // { spec, ledger }

function matches(matcher, value) {
  if (matcher instanceof RegExp) return matcher.test(value);
  return matcher === value;
}

function matchFetch(stub, { method, host, path }) {
  if (!matches(stub.host, host)) return false;
  const stubMethod = (stub.method ?? 'GET').toUpperCase();
  if (stubMethod !== method.toUpperCase()) return false;
  if (!matches(stub.path, path)) return false;
  return true;
}

class NetworkBlockedError extends Error {
  constructor(host, path) { super(`NetworkBlocked: ${host}${path}`); }
}

export function installStubs(spec) {
  if (state) uninstallStubs();
  state = { spec, ledger: [] };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const meta = { method, host: url.host, path: url.pathname, query: url.search };

    for (const stub of spec.fetch ?? []) {
      if (matchFetch(stub, meta)) {
        state.ledger.push({ event: 'call', ...meta });
        const r = stub.response ?? { status: 200 };
        const body = r.body !== undefined
          ? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
          : '';
        return new Response(body, {
          status: r.status ?? 200,
          headers: r.headers ?? { 'content-type': 'application/json' },
        });
      }
    }
    state.ledger.push({ event: 'block', ...meta });
    throw new NetworkBlockedError(url.host, url.pathname);
  };
}

export function uninstallStubs() {
  if (!state) return;
  globalThis.fetch = realFetch;
  state = null;
}

export function getLedger() {
  return state ? [...state.ledger] : [];
}

export function hasBlockEvents() {
  return state ? state.ledger.some((e) => e.event === 'block') : false;
}

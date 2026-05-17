// index.js — public exports for the introspection faculty.
//
// The daemon's server.js imports startIntrospection / stopIntrospection from
// here; tests import the same surface.  Other Phase 1 internals (queue-poller,
// outcome-inference, budget) are importable directly for unit testing.

export { startIntrospection, stopIntrospection } from './faculty.js';

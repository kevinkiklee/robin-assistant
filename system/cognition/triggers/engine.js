// Event-driven trigger engine — pure dispatch logic, no DB.
//
// A trigger is:
//   {
//     name:       string,                     // unique
//     on:         string,                     // event.source to match
//     when?:      ({ event }) => boolean,     // optional condition predicate
//     cooldownMs?: number,                    // refuse to fire within window
//     priority?:  number,                     // default 100; lower fires first
//     do:         Array<Action>,              // serial action chain
//   }
//
// Action is:
//   {
//     tool:    string,                                  // MCP tool name to dispatch
//     args:    object | ({ event }) => object | Promise // static or computed
//     retries?: number,                                 // default 3
//   }
//
// processEvent({ event, dispatchTool, lookupLastFire, recordFire }) returns:
//   { matched, fired, skipped_cycle?, results: [{name, status, ...}] }
//
// Cycle protection: every dispatchTool call receives a `triggered_by_chain`
// option containing the chain of trigger names that led to it. Downstream
// writes that record an event should propagate this onto the new event row
// (see `event.triggered_by_chain`). The engine refuses to process any event
// whose chain depth is already at maxChainDepth (default 3).

export function createTriggerEngine({
  sleep = realSleep,
  maxChainDepth = 3,
  logger = console,
} = {}) {
  const triggers = new Map();

  function register(trigger) {
    validate(trigger);
    triggers.set(trigger.name, trigger);
  }

  function unregister(name) {
    triggers.delete(name);
  }

  function list() {
    return [...triggers.values()];
  }

  async function processEvent({
    event,
    dispatchTool,
    lookupLastFire = async () => null,
    recordFire = async () => {},
  }) {
    if (!event || typeof event !== 'object') {
      throw new Error('processEvent: event is required');
    }
    const chain = Array.isArray(event.triggered_by_chain) ? event.triggered_by_chain : [];
    if (chain.length >= maxChainDepth) {
      logger.warn?.(
        `[triggers] cycle protection: chain depth ${chain.length} >= ${maxChainDepth}, skipping event ${event.id ?? '<no id>'}`,
      );
      return { matched: 0, fired: 0, skipped_cycle: true, results: [] };
    }

    const matching = [...triggers.values()]
      .filter((t) => t.on === event.source)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    const results = [];
    for (const trigger of matching) {
      const result = await tryFireTrigger({
        trigger,
        event,
        chain,
        dispatchTool,
        lookupLastFire,
        recordFire,
        sleep,
      });
      results.push(result);
    }
    return {
      matched: matching.length,
      fired: results.filter((r) => r.status === 'ok').length,
      results,
    };
  }

  return { register, unregister, list, processEvent };
}

function validate(trigger) {
  if (!trigger || typeof trigger !== 'object') {
    throw new Error('trigger must be an object');
  }
  if (!trigger.name || typeof trigger.name !== 'string') {
    throw new Error('trigger.name required (string)');
  }
  if (!trigger.on || typeof trigger.on !== 'string') {
    throw new Error(`trigger ${trigger.name}: on required (string)`);
  }
  if (!Array.isArray(trigger.do) || trigger.do.length === 0) {
    throw new Error(`trigger ${trigger.name}: do must be a non-empty array`);
  }
  for (const action of trigger.do) {
    if (!action?.tool || typeof action.tool !== 'string') {
      throw new Error(`trigger ${trigger.name}: action.tool required (string)`);
    }
  }
  if (trigger.when != null && typeof trigger.when !== 'function') {
    throw new Error(`trigger ${trigger.name}: when must be a function`);
  }
}

async function tryFireTrigger({
  trigger,
  event,
  chain,
  dispatchTool,
  lookupLastFire,
  recordFire,
  sleep,
}) {
  const start = Date.now();

  // Condition check.
  if (typeof trigger.when === 'function') {
    let pass;
    try {
      pass = trigger.when({ event });
      if (pass && typeof pass.then === 'function') pass = await pass;
    } catch (e) {
      const rec = {
        name: trigger.name,
        status: 'failed',
        event_id: event.id ?? null,
        duration_ms: Date.now() - start,
        error: `when threw: ${e?.message ?? e}`,
      };
      await recordFire(rec);
      return rec;
    }
    if (!pass) {
      const rec = {
        name: trigger.name,
        status: 'skipped',
        event_id: event.id ?? null,
        duration_ms: Date.now() - start,
        reason: 'condition_false',
      };
      await recordFire(rec);
      return rec;
    }
  }

  // Cooldown check.
  if (trigger.cooldownMs) {
    const last = await lookupLastFire(trigger.name);
    if (last && Number.isFinite(last.fired_at_ms)) {
      const elapsed = Date.now() - last.fired_at_ms;
      if (elapsed < trigger.cooldownMs) {
        const rec = {
          name: trigger.name,
          status: 'skipped',
          event_id: event.id ?? null,
          duration_ms: Date.now() - start,
          reason: 'cooldown',
          cooldown_remaining_ms: trigger.cooldownMs - elapsed,
        };
        await recordFire(rec);
        return rec;
      }
    }
  }

  // Run actions serially with retry.
  const nextChain = [...chain, trigger.name];
  for (let i = 0; i < trigger.do.length; i += 1) {
    const action = trigger.do[i];
    const maxAttempts = Math.max(1, action.retries ?? 3);
    let lastErr = null;
    let ok = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const args =
          typeof action.args === 'function' ? await action.args({ event }) : action.args ?? {};
        await dispatchTool(action.tool, args, { triggered_by_chain: nextChain });
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts - 1) {
          const backoffMs = 2 ** attempt * 1000; // 1s, 2s, 4s
          await sleep(backoffMs);
        }
      }
    }
    if (!ok) {
      const rec = {
        name: trigger.name,
        status: 'failed',
        event_id: event.id ?? null,
        duration_ms: Date.now() - start,
        error: `action[${i}] ${action.tool}: ${lastErr?.message ?? lastErr}`,
        action_index: i,
      };
      await recordFire(rec);
      return rec;
    }
  }

  const rec = {
    name: trigger.name,
    status: 'ok',
    event_id: event.id ?? null,
    duration_ms: Date.now() - start,
  };
  await recordFire(rec);
  return rec;
}

function realSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

import { describe, it } from 'node:test';
import { runScenario } from './scenario.js';

describe('scenario: self-test', () => {
  it('throws when fixture does not exist', async () => {
    let threw = false;
    try { await runScenario({ fixture: 'nonexistent/x', steps: [] }); }
    catch (e) { threw = /fixture not found/.test(e.message); }
    if (!threw) throw new Error('expected fixture-not-found error');
  });
});

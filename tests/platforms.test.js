import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS } from '../core/scripts/lib/platforms.js';

describe('platform pointer content', () => {
  it('includes capture anchor in all pointer files', () => {
    for (const [name, config] of Object.entries(PLATFORMS)) {
      if (config.pointerContent) {
        assert.ok(
          config.pointerContent.includes('capturable signals'),
          `${name} pointer file should include capture anchor`
        );
        assert.ok(
          config.pointerContent.includes('inbox.md'),
          `${name} pointer file should reference inbox.md`
        );
      }
    }
  });

  it('preserves AGENTS.md reference in all pointer files', () => {
    for (const [name, config] of Object.entries(PLATFORMS)) {
      if (config.pointerContent) {
        assert.ok(
          config.pointerContent.includes('AGENTS.md'),
          `${name} pointer file should still reference AGENTS.md`
        );
      }
    }
  });
});

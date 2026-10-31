import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentFilename, isLocalAttachmentUrl } from './files.ts';

test('isLocalAttachmentUrl: relative preset/doc links only', () => {
  assert.equal(isLocalAttachmentUrl('look.xmp'), true);
  assert.equal(isLocalAttachmentUrl('presets/Lakeport%20Dusk.XMP'), true);
  assert.equal(isLocalAttachmentUrl('grade.cube?v=2'), true);
  assert.equal(isLocalAttachmentUrl('file:///tmp/a.pdf'), true);
  assert.equal(isLocalAttachmentUrl('https://x.example/a.xmp'), false, 'remote');
  assert.equal(isLocalAttachmentUrl('/@quinn/page'), false, 'site path');
  assert.equal(isLocalAttachmentUrl('#day-3'), false, 'anchor');
  assert.equal(isLocalAttachmentUrl('page.html'), false, 'html never served from blob');
  assert.equal(isLocalAttachmentUrl('diagram.svg'), false, 'svg never served from blob');
  assert.equal(isLocalAttachmentUrl(undefined), false);
});

test('attachmentFilename keeps a safe basename', () => {
  assert.equal(attachmentFilename('/tmp/x/Lakeport Dusk (v2).xmp'), 'Lakeport-Dusk-v2-.xmp');
  assert.equal(attachmentFilename('a.cube'), 'a.cube');
});

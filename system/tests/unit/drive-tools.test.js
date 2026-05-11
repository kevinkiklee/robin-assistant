import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDriveGetFileTool } from '../../io/integrations/google_drive/tools/drive-get-file.js';
import { createDriveSearchTool } from '../../io/integrations/google_drive/tools/drive-search.js';

test('drive_search has correct schema', () => {
  const t = createDriveSearchTool();
  assert.equal(t.name, 'drive_search');
  assert.ok(t.inputSchema.required.includes('query'));
});

test('drive_get_file has correct schema', () => {
  const t = createDriveGetFileTool();
  assert.equal(t.name, 'drive_get_file');
  assert.ok(t.inputSchema.required.includes('file_id'));
});

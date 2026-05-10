import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getGoogleAccessToken } from '../../_auth/token-cache.js';
import { WORKSPACE_DOC, getFileBody, getFileMetadata } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createDriveGetFileTool() {
  return {
    name: 'drive_get_file',
    description:
      'Fetch Google Drive file metadata; body for text/Docs only, ≤100KB. Sheets/Slides return metadata + browser link.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
    handler: async (args) => {
      try {
        const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
        const metadata = await getFileMetadata({ accessToken, fileId: args.file_id });
        if (
          metadata.mimeType?.startsWith('application/vnd.google-apps.') &&
          metadata.mimeType !== WORKSPACE_DOC
        ) {
          return { metadata, body: null, body_status: 'workspace_format_not_supported' };
        }
        try {
          const result = await getFileBody({
            accessToken,
            fileId: args.file_id,
            mimeType: metadata.mimeType,
          });
          if (result === null) return { metadata, body: null, body_status: 'mime_not_text' };
          return {
            metadata,
            body: result.body,
            body_status: result.truncated ? 'truncated_at_100KB' : 'full',
          };
        } catch (e) {
          return { metadata, body: null, body_status: `error: ${e.message}` };
        }
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error(
            'Google not authenticated; run: robin secrets import --from <v1-user-data>',
          );
        }
        throw e;
      }
    },
  };
}

// MCP tool: send an iMessage to a buddy or a group chat.
// Backed by system/io/integrations/imessage/sender.js (osascript).
//
// Outbound writes are gated by the standard action-policy AUTO/ASK/NEVER
// flow at the caller layer (handled by the MCP framework, not here) and by
// the iMessage sender's internal rate limit.

import { sendDm, sendGroup } from '../../integrations/imessage/sender.js';

export function createImessageSendTool({ runCommand, platform } = {}) {
  return {
    name: 'imessage_send',
    description:
      'Send an iMessage. Target a buddy by `handle` (phone or email) for a DM, or a group by `chat_guid`. macOS only; no-op on other hosts.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Recipient handle (phone or email) for a DM' },
        chat_guid: {
          type: 'string',
          description: 'Group chat GUID (mutually exclusive with handle)',
        },
        message: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['message'],
    },
    handler: async (args) => {
      const { handle, chat_guid, message } = args ?? {};
      if (!message || typeof message !== 'string') {
        throw new Error('imessage_send: message required (string)');
      }
      if (handle && chat_guid) {
        throw new Error('imessage_send: pass either handle OR chat_guid, not both');
      }
      if (!handle && !chat_guid) {
        throw new Error('imessage_send: handle or chat_guid is required');
      }
      if (chat_guid) {
        return sendGroup({ chatGuid: chat_guid, message, runCommand, platform });
      }
      return sendDm({ handle, message, runCommand, platform });
    },
  };
}

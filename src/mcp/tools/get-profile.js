import { getProfile } from '../../memory/profile.js';

export function createGetProfileTool({ db }) {
  return {
    name: 'get_profile',
    description:
      'Read the user profile (name, pronouns, timezone, interests). Profile updates flow through rule_candidates approval.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const p = await getProfile(db);
      if (!p) return { profile: null };
      return { profile: { ...p, id: p.id ? String(p.id) : null } };
    },
  };
}

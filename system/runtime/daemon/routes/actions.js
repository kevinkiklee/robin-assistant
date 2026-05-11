import { resetActionTrust, setActionTrust } from '../../../cognition/jobs/action-trust.js';

const VALID_STATES = ['AUTO', 'ASK', 'NEVER'];

export const actionsRoutes = [
  {
    method: 'POST',
    path: '/internal/actions/set',
    schema: { class: 'string', state: 'string' },
    async handler({ ctx, body }) {
      if (!VALID_STATES.includes(body.state)) {
        return { _status: 400, _body: { ok: false, reason: 'invalid_input' } };
      }
      await setActionTrust(ctx.db, body.class, body.state, 'user');
      // 200 status is the success signal; envelope adds ok: true.
      return { class: body.class, state: body.state };
    },
  },
  {
    method: 'POST',
    path: '/internal/actions/reset',
    schema: { class: 'string' },
    async handler({ ctx, body }) {
      await resetActionTrust(ctx.db, body.class);
      return { class: body.class, state: 'ASK' };
    },
  },
];

import { resetActionTrust, setActionTrust } from '../../../cognition/jobs/action-trust.js';

const VALID_STATES = ['AUTO', 'ASK', 'NEVER'];

export const actionsRoutes = [
  {
    method: 'POST',
    path: '/internal/actions/set',
    async handler({ ctx, body }) {
      if (!body?.class || !VALID_STATES.includes(body?.state)) {
        return { _status: 400, _body: { ok: false, reason: 'invalid_input' } };
      }
      await setActionTrust(ctx.db, body.class, body.state, 'user');
      return { ok: true, class: body.class, state: body.state };
    },
  },
  {
    method: 'POST',
    path: '/internal/actions/reset',
    async handler({ ctx, body }) {
      if (!body?.class) {
        return { _status: 400, _body: { ok: false, reason: 'missing_class' } };
      }
      await resetActionTrust(ctx.db, body.class);
      return { ok: true, class: body.class, state: 'ASK' };
    },
  },
];

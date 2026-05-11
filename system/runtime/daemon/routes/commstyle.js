import { synthesizeCommStyle } from '../../../cognition/jobs/comm-style.js';

export const commstyleRoutes = [
  {
    method: 'POST',
    path: '/internal/comm-style/refresh',
    async handler({ ctx }) {
      return await synthesizeCommStyle(ctx.db, ctx.host);
    },
  },
];

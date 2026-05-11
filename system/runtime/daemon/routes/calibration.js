import { computeCalibration, setCalibration } from '../../../cognition/jobs/predictions.js';

export const calibrationRoutes = [
  {
    method: 'POST',
    path: '/internal/calibration/refresh',
    async handler({ ctx }) {
      const c = await computeCalibration(ctx.db);
      await setCalibration(ctx.db, c);
      return c;
    },
  },
];

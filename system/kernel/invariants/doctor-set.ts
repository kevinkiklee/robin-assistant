import type { RobinDb } from '../../brain/memory/db.ts';
import {
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  dbWalSizeBoundedInvariant,
  integrationsHealthyInvariant,
  jobsDiscoverableInvariant,
  jobsHistoryBoundedInvariant,
  jobsRetriesBoundedInvariant,
  noOrphansInvariant,
  recallTopicsResolvableInvariant,
  schedulerProgressingInvariant,
  userDataWritableInvariant,
  vecIndexSyncedInvariant,
} from './builtins/index.ts';
import type { Invariant } from './types.ts';

/**
 * The canonical doctor invariant set — shared by `robin doctor [--fix]` (CLI) and
 * the daily `doctor.run` job so the manual and unattended paths can never drift.
 * Lives in the kernel layer (not the CLI surface) so brain/cognition can import it
 * without an inverted brain → surfaces dependency.
 */
export function buildDoctorInvariants(db: RobinDb, userData: string): Invariant[] {
  return [
    userDataWritableInvariant(userData),
    dbReachableInvariant(db),
    dbSchemaCurrentInvariant(db),
    dbWalSizeBoundedInvariant(db),
    vecIndexSyncedInvariant(db),
    integrationsHealthyInvariant(db),
    jobsDiscoverableInvariant(db),
    jobsHistoryBoundedInvariant(db),
    jobsRetriesBoundedInvariant(db),
    schedulerProgressingInvariant(db, { userData }),
    noOrphansInvariant(db, { userData }),
    recallTopicsResolvableInvariant({ userData }),
  ];
}

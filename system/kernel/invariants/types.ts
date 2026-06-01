export interface InvariantCheckResult {
  ok: boolean;
  message?: string;
  remediation?: string;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Invariant {
  name: string; // dot-namespaced, e.g. 'db.reachable'
  severity: Severity;
  symptom: string; // human-readable; for RUNBOOK
  cause: string; // human-readable; for RUNBOOK
  fix: string; // human-readable remediation steps; for RUNBOOK
  check: () => Promise<InvariantCheckResult> | InvariantCheckResult;
  repair?: () => Promise<void> | void;
}

export interface InvariantReport {
  name: string;
  severity: Severity;
  ok: boolean;
  message?: string;
  remediation?: string;
  duration_ms: number;
  /** Set when a repair was attempted for this invariant (doctor --fix / daily run). */
  repaired?: boolean;
  /** The repair's error message, if it threw. `ok` then reflects the post-repair re-check. */
  repair_error?: string;
}

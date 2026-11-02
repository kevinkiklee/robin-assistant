// lab/copy/arm.ts
//
// An experiment arm: a named tuning patch plus an optional dream-step override.
import { type DreamStep, parseDreamSteps } from '../../system/brain/cognition/dream.ts';
import {
  setTuning,
  type TuningPatch,
  validateTuningPatch,
} from '../../system/brain/memory/tuning.ts';
import { labSteps } from './profile.ts';

export interface Arm {
  name: string;
  tuning?: TuningPatch;
  steps?: string[];
}

export const ARM_NAME = /^[a-z0-9-]+$/;

export function parseArm(json: unknown): Arm {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('arm must be an object');
  }
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'name' && k !== 'tuning' && k !== 'steps') throw new Error(`unknown arm key: ${k}`);
  }
  if (typeof o.name !== 'string' || !ARM_NAME.test(o.name)) {
    throw new Error(`invalid arm name: ${String(o.name)} (want /^[a-z0-9-]+$/)`);
  }
  const arm: Arm = { name: o.name };
  if (o.tuning !== undefined) {
    validateTuningPatch(o.tuning);
    arm.tuning = o.tuning;
  }
  if (o.steps !== undefined) {
    if (!Array.isArray(o.steps) || o.steps.some((s) => typeof s !== 'string')) {
      throw new Error('arm steps must be a string array');
    }
    parseDreamSteps(o.steps as string[]);
    arm.steps = [...(o.steps as string[])];
  }
  return arm;
}

/** Apply the arm's tuning to this process and return the dream steps it runs. */
export function applyArm(arm: Arm, mode: 'template' | 'config'): ReadonlySet<DreamStep> {
  if (arm.tuning) setTuning(arm.tuning);
  return arm.steps ? parseDreamSteps(arm.steps) : labSteps(mode);
}

import type { DeliveryTarget } from '../deliveries.ts';

export interface Recipe {
  provider: string;
  modes: Array<'create' | 'rotate' | 'get'>;
  startUrl: string;
  /** Prose for the agent, pre-reveal only. */
  steps: string[];
  /** JS run in the page; evaluates to {ok:boolean}. */
  precheck?: string;
  /** JS run in the page; evaluates to {found} or {found:true,x,y}. Never page text. */
  locateReveal?: string;
  locateCopy?: string;
  /**
   * JS run in the page inside the blind window when locateCopy finds nothing.
   * Returns structure only (tags, roles, sizes, positions, letter-only labels,
   * booleans for "this text has the key's shape") — never page text.
   */
  inspectReveal?: string;
  shape: RegExp;
  /** Env var the key usually goes to. */
  defaultName: string;
  target: DeliveryTarget;
  rotate: 'roll' | 'create-revoke' | 'oauth';
  oauthIntegration?: 'gmail' | 'google_calendar' | 'whoop';
}

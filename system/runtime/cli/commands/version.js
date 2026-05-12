import { pointerExists, robinHome } from '../../../config/data-store.js';
import { getCliVersion } from '../../daemon/version-handshake.js';

export async function version() {
  const v = await getCliVersion();
  console.log(`robin-assistant ${v}`);
  // Pre-install (or relocate-in-progress) is a legitimate state for
  // `robin --version`. Don't make `--version` throw — the user is likely
  // running it precisely BECAUSE they haven't finished installing.
  if (!pointerExists()) {
    console.log('home: (not installed — run `robin install`)');
    return;
  }
  try {
    console.log(`home: ${robinHome()}`);
  } catch (e) {
    console.log(`home: (unavailable — ${e.message})`);
  }
}

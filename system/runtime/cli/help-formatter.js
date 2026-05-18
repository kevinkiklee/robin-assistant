// help-formatter.js — shared help-text utilities.
//
// `appendRelated(text, name)` appends a `Related: <siblings>` line to a help
// string when the command has siblings in `command-registry.js`. Used by the
// centralized --help dispatch in `index.js` (and any per-command --help paths)
// to surface adjacent commands without per-command boilerplate.

import { relatedFor } from './command-registry.js';

export function appendRelated(helpText, commandName) {
  const siblings = relatedFor(commandName);
  if (siblings.length === 0) return helpText;
  const trimmed = helpText.replace(/\s*$/, '');
  return `${trimmed}\n\nRelated: ${siblings.join(', ')}\n`;
}

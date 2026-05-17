// correction-inference.js — detects when a user turn is a correction of the
// prior assistant turn. Pure logic — no DB writes. The caller decides what to
// do with the verdict.
//
// Spec §5: fires when pattern match AND antecedent qualifies.
//
// Antecedent qualification:
//   - ≥1 STRONG signal  (ask_user_question_call OR predict_call)
//   - OR ≥2 WEAK signals (numbered_list_ge2, ends_with_question_mark, outbound_write_performed)

import { ANTECEDENT_KINDS, CORRECTION_REGEXES } from '../introspection/inference-rules.js';

const OUTBOUND_TOOL_NAMES = new Set([
  'discord_send',
  'github_write',
  'spotify_write',
  // mcp__ prefixed variants (in-session tool names may include the server prefix)
  'mcp__robin__discord_send',
  'mcp__robin__github_write',
  'mcp__robin__spotify_write',
]);

/**
 * Pattern check — does the user turn LOOK like a correction?
 * Pure regex over the trimmed turn text.
 *
 * @param {string} userText
 * @returns {boolean}
 */
export function matchesCorrectionPattern(userText) {
  if (typeof userText !== 'string') return false;
  const trimmed = userText.trim();
  if (trimmed.length === 0) return false;
  return CORRECTION_REGEXES.some((re) => re.test(trimmed));
}

/**
 * Antecedent check — does the prior assistant turn QUALIFY as a correctable
 * antecedent? Per spec §5: at least one STRONG signal OR two WEAK signals.
 *
 * @param {{ text: string, tool_calls: Array<{name: string}> }} priorTurn
 * @returns {{ strong: string[], weak: string[], qualifies: boolean }}
 */
export function classifyAntecedent(priorTurn) {
  if (!priorTurn || typeof priorTurn !== 'object') {
    return { strong: [], weak: [], qualifies: false };
  }

  const text = typeof priorTurn.text === 'string' ? priorTurn.text : '';
  const toolCalls = Array.isArray(priorTurn.tool_calls) ? priorTurn.tool_calls : [];
  const toolNames = toolCalls
    .map((tc) => (tc && typeof tc.name === 'string' ? tc.name.toLowerCase() : ''))
    .filter(Boolean);

  const strong = [];
  const weak = [];

  // --- STRONG signals ---

  // (a) AskUserQuestion call
  if (toolNames.some((n) => n === 'askuserquestion' || n.endsWith(':askuserquestion'))) {
    strong.push(ANTECEDENT_KINDS.STRONG[0]); // 'ask_user_question_call'
  }

  // (c) predict() call
  if (
    toolNames.some(
      (n) =>
        n === 'predict' ||
        n.endsWith(':predict') ||
        n === 'mcp__robin__predict' ||
        n === 'robin__predict',
    )
  ) {
    strong.push(ANTECEDENT_KINDS.STRONG[1]); // 'predict_call'
  }

  // --- WEAK signals ---

  // (b) Contains numbered/lettered list ≥2 items
  const numberedListCount = (text.match(/^\s*(?:\d+[.):]|[a-zA-Z][.):])\s+\S/gm) || []).length;
  if (numberedListCount >= 2) {
    weak.push(ANTECEDENT_KINDS.WEAK[0]); // 'numbered_list_ge2'
  }

  // (d) Ends in '?'
  const rstripped = text.trimEnd();
  if (rstripped.endsWith('?')) {
    weak.push(ANTECEDENT_KINDS.WEAK[1]); // 'ends_with_question_mark'
  }

  // (e) Performed an outbound write
  if (toolNames.some((n) => OUTBOUND_TOOL_NAMES.has(n))) {
    weak.push(ANTECEDENT_KINDS.WEAK[2]); // 'outbound_write_performed'
  }

  const qualifies = strong.length >= 1 || weak.length >= 2;

  return { strong, weak, qualifies };
}

/**
 * Full inference — combine pattern + antecedent.
 *
 * @param {{ userText: string, priorTurn: { text: string, tool_calls: Array<{name: string}> } }} args
 * @returns {{ fires: boolean, reason?: string, signals?: { matched_pattern: boolean, antecedent: ReturnType<classifyAntecedent> } }}
 */
export function inferCorrection({ userText, priorTurn }) {
  const matched_pattern = matchesCorrectionPattern(userText);
  if (!matched_pattern) {
    return { fires: false, reason: 'no_pattern_match' };
  }

  const antecedent = classifyAntecedent(priorTurn);
  if (!antecedent.qualifies) {
    return {
      fires: false,
      reason: 'antecedent_unqualified',
      signals: { matched_pattern, antecedent },
    };
  }

  return {
    fires: true,
    signals: { matched_pattern, antecedent },
  };
}

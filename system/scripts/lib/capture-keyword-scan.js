// system/scripts/lib/capture-keyword-scan.js
//
// Scans a user message and assigns a capture-enforcement tier.
//   tier 1 — trivial (skip enforcement)
//   tier 2 — light enforcement (marker accepted without justification)
//   tier 3 — full enforcement (marker requires reason)

const KEYWORDS = [
  'remember', 'decided', 'preferred', 'preference',
  'actually', 'no — ', 'no, ', "don't", 'do not',
  'correction', 'wrong', 'always', 'never',
];

const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?)\b/i;
const MONEY_RE = /\$[\d,]+(?:\.\d+)?/;
const PROPER_ATTR_RE = /\b[A-Z][a-z]+\s+(?:is|was|are|were|has|have|said|told)\b/;
// GREETING_RE is a backstop in case t2 is configured below ~3 via thresholds — at the default t2=5,
// every greeting-matching string already short-circuits to tier 1 via wc < t2.
const GREETING_RE = /^(?:hi|hey|hello|thanks|thank you|ok|okay|cool|nice|got it|sure|yes|no|sounds good)\b[\s.!?]*$/i;

export function scanKeywords(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const kw of KEYWORDS) {
    if (lower.includes(kw)) hits.push(kw);
  }
  const dateMatch = text.match(DATE_RE);
  if (dateMatch) hits.push(`date:${dateMatch[0]}`);
  const moneyMatch = text.match(MONEY_RE);
  if (moneyMatch) hits.push(`money:${moneyMatch[0]}`);
  if (PROPER_ATTR_RE.test(text)) hits.push('proper-attribution');
  return hits;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanEntityAliases(text, aliases) {
  if (!aliases?.length) return [];
  const pattern = new RegExp(`\\b(${aliases.map(escapeRegex).join('|')})\\b`, 'gi');
  const found = new Set();
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const original = aliases.find((a) => a.toLowerCase() === m[1].toLowerCase());
    if (original) found.add(original);
  }
  return [...found];
}

function wordCount(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

export function classifyTier({ userMessage, entityAliases = [], thresholds = {} }) {
  const t2 = thresholds.tier2 ?? 5;
  const t3 = thresholds.tier3 ?? 20;
  const wc = wordCount(userMessage);
  const keywords = scanKeywords(userMessage);
  const entitiesMatched = scanEntityAliases(userMessage, entityAliases);

  if (wc < t2 || GREETING_RE.test(userMessage.trim())) {
    return { tier: 1, reason: 'short', wc, keywords, entitiesMatched };
  }
  if (wc >= t3 || keywords.length > 0 || entitiesMatched.length > 0) {
    return { tier: 3, reason: keywords.length ? 'keywords' : (entitiesMatched.length ? 'entity' : 'long'), wc, keywords, entitiesMatched };
  }
  return { tier: 2, reason: 'medium', wc, keywords, entitiesMatched };
}

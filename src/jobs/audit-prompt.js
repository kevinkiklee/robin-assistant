// src/jobs/audit-prompt.js
export function buildAuditPrompt(a_content, b_content) {
  return `Two memory claims:

Claim A: ${a_content}
Claim B: ${b_content}

Do these contradict each other? Respond with strict JSON only:

{"contradict": true|false, "summary": "one sentence"}`;
}

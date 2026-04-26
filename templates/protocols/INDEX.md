# Protocols Index

Operational workflows that run on-demand or on cadence. When the user invokes a trigger phrase, read and follow the corresponding protocol.

| Protocol | File | Triggers |
|----------|------|----------|
| Morning Briefing | `morning-briefing.md` | "morning briefing", "good morning", "brief me", "what's today" |
| Weekly Review | `weekly-review.md` | "weekly review", "Sunday review" |
| Email Triage | `email-triage.md` | "triage my inbox", "email triage", "go through my email" |
| Meeting Prep | `meeting-prep.md` | "prep for my meeting", "help me prep for [event]" |
| Subscription Audit | `subscription-audit.md` | "subscription audit", "what am I paying for" |
| Receipt Tracking | `receipt-tracking.md` | "track my receipts", "find receipts for" |
| Todo Extraction | `todo-extraction.md` | "extract todos", "what do I need to do from this" |
| Monthly Financial | `monthly-financial.md` | "monthly financial check-in", "month-end review" |
| Dream | `dream.md` | (automatic at session startup when eligible) |
| System Maintenance | `system-maintenance.md` | "system maintenance", "clean up the workspace" |
| Quarterly Self-Assessment | `quarterly-self-assessment.md` | "quarterly self-assessment", "how have you been doing" |
| Multi-Session Coordination | `multi-session-coordination.md` | (automatic), "list active sessions" |

## Cadence

- **Per session:** Dream (automatic eligibility check)
- **Monthly:** System Maintenance (first session of month)
- **Quarterly:** Quarterly Self-Assessment (first session of quarter)
- **Triggered:** All others — invoked by user trigger phrases

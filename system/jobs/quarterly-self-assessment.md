---
name: quarterly-self-assessment
triggers: ["how have you been doing", "quarterly review"]
description: Quarterly review of self-improvement effectiveness, calibration accuracy, and pattern impact.
runtime: "agent"
schedule: "0 9 1 1,4,7,10 *"
enabled: false
catch_up: true
timeout_minutes: 30
notify_on_failure: true
---
# Protocol: Quarterly Self-Assessment

Every 3 months, assess whether self-improvement is working — not just logging activity.

## Triggers

"quarterly self-assessment", "review your performance", "how have you been doing"

Proactive: first session of each quarter (Jan/Apr/Jul/Oct).

## Steps

### 1. Effectiveness audit

Pick 5 high-stakes responses from the past 90 days (financial advice, health recommendations, action items). For each:
- Was the recommendation correct?
- Did the user act on it?
- What was the outcome?
- Grade 1-5

Compare to prior quarter's grades.

### 2. Calibration audit

Read `user-data/memory/self-improvement/calibration.md`. For verified predictions: was tagged confidence calibrated to actual accuracy? Group by band (50%/70%/90%) and check.

### 3. Correction/Pattern compounding

- How many corrections in 90 days vs prior quarter?
- For each pattern in the patterns subtopic file under `user-data/memory/self-improvement/`: is the counter-action working?

### 4. Sycophancy check

- Read entries across `user-data/memory/self-improvement/` (especially `corrections.md`). Are most entries positive corrections?
- Is the disagreement count zero? If so, scan for moments the assistant should have pushed back.
- High wins-to-corrections ratio + low disagreement = probably optimizing for praise.

### 5. Ask the user to grade the assistant

Direct: "Honestly, how am I doing? What's working? What's not?" Log response in `user-data/memory/self-improvement/corrections.md` or `user-data/memory/self-improvement/calibration.md`.

### 6. Identify ONE thing to change

Pick the single highest-leverage improvement for the next quarter.

## Output

```
## Quarterly Self-Assessment — YYYY-Q#

### Effectiveness: [grades, trend]
### Calibration: [accuracy by band]
### Corrections/Patterns: [count, trend]
### Sycophancy: [concern yes/no, evidence]
### User's grade: [quote]
### One thing to change: [specific commitment]
```

## After

Log in `user-data/memory/streams/journal.md`. Update `user-data/memory/self-improvement/calibration.md`.

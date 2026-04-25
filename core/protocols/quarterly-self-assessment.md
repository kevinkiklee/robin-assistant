# Protocol: Quarterly Self-Assessment

Every 3 months, take a hard look at whether self-improvement is actually working — not just whether it's logging activity.

## Triggers
"quarterly self-assessment", "review your performance", "how have you been doing"

Proactive: First session of each quarter (Jan/Apr/Jul/Oct).

## Steps

### 1. Effectiveness audit
Pick 5 high-stakes responses from the past 90 days (financial advice, health recommendations, calendar/email actions). For each:
- Was the recommendation correct?
- Did the user act on it?
- What was the outcome?
- Grade 1-5

Compare to the previous quarter's grades. Trend up = working. Flat or down = improvements aren't compounding.

### 2. Calibration audit
Read `self-improvement/predictions.md`. For each verified outcome:
- Was tagged confidence calibrated to actual accuracy?
- Group by confidence band (50%, 70%, 90%) and check: were 90%-tagged predictions correct ~90% of the time?

If overconfident: tighten future tags. If underconfident: loosen.

### 3. Skill usage review
Read `self-improvement/skill-usage.md`. For each skill:
- How many invocations in 90 days?
- What % "used as-is" vs "discussed but not used" vs "ignored"?
- Skills with 0 invocations → propose retirement
- Skills with consistent "ignored" → review if the playbook actually matches the user's needs

### 4. Mistake / pattern compounding check
- How many mistakes in past 90 days vs prior quarter?
- For each pattern in `patterns.md`: is the counter-action working? Or are we still seeing instances?
- Promote any mistakes that hit 2+ occurrences to patterns.

### 5. Sycophancy check
- Read `self-improvement/feedback.md`. Are most entries positive?
- Read `self-improvement/wins.md` and `mistakes.md`. Ratio?
- If overwhelmingly positive feedback + high wins:mistakes ratio + low disagreement budget hit count → I'm probably optimizing for praise, not correctness. Force a steelman.

### 6. Disagreement budget check
- How many times did I push back on the user's stated intent in 90 days? (`Rule: Disagree`)
- If zero: I'm too deferent. Either I haven't seen anything worth pushing back on, OR I'm avoiding it.
- Look for moments I should have disagreed but didn't. Add to corrections.

### 7. System rot check
- Memory files older than 180 days with no updates → archive candidates
- Todos with no activity >60 days → reconcile with the user
- Improvements proposed but never implemented → re-propose or close

### 8. Ask the user to grade the assistant
Direct prompt: "Honestly, how am I doing? What's working? What's not?"
Log response in `feedback.md`. Weight the user's signal above my self-assessment.

### 9. Identify ONE thing to change
Don't try to fix 17 things at once again. Pick the single highest-leverage change for the next quarter and commit to it.

## Output
```
## Quarterly Self-Assessment — YYYY-Q#

### Effectiveness
- Sample grades: [scores]
- vs prior quarter: [trend]

### Calibration
- 50%/70%/90% accuracy: [actuals]
- Adjustment: [what to change]

### Skills
- Used: [list]
- Retire: [list]

### Mistakes / Patterns
- New mistakes: N
- Patterns reinforced: [list]

### Sycophancy / Disagreement
- Feedback positivity ratio: [N positive / M total]
- Disagreement instances: N
- Concern: [yes/no]

### User's grade
[quote]

### One thing to change next quarter
[specific commitment]
```

## After
- Commit changes if using git.
- Note completion date in `memory/short-term/last-quarterly-self-assessment.md`.

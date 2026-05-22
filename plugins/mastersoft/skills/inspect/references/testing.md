# Troubleshooting

## Skill doesn't trigger
**Symptom:** `inspect` is not selected for code inspection requests.
**Cause:** Prompt asks for implementation instead of inspection feedback.
**Solution:** Use explicit inspection phrasing:
- "Inspect these files and list actionable issues."
- "Code inspection only; no edits."
- "Prioritize correctness and security findings."

## Skill triggers too often
**Symptom:** `inspect` activates for tasks that require code changes.
**Cause:** Prompt mixes inspection language with implementation intent.
**Solution:** Add anti-triggers:
- "Fix these issues directly."
- "Implement this feature."
- "Refactor this module now."

## Tool/MCP connection errors
**Symptom:** Inspection coverage is incomplete.
**Cause:** Missing/invalid target paths or limited read scope.
**Solution:**
1. Validate file/folder paths before starting.
2. Narrow to explicit files when repository scope is too large.
3. Report unreadable paths and continue with available evidence.

## Unexpected behavior or errors
**Symptom:** Feedback is generic or not prioritized.
**Cause:** Findings not tied to concrete code locations.
**Solution:** Provide high-signal issues with severity/impact, cite exact files, and keep recommendations actionable.

# Test Protocols

## 1. Triggering Tests
**Goal:** `inspect` should activate for feedback-only code inspection tasks and avoid implementation requests.

**Should trigger:**
- "Inspect `src/auth` and list high-severity correctness/security issues."
- "Code inspection only for this patch; no edits."
- "Inspect these files and prioritize blocking issues first."

**Should NOT trigger:**
- "Fix the auth issues directly."
- "Refactor `src/auth` for readability."
- "Run performance benchmarks on auth endpoints."

## 2. Functional Tests
**Test case: Actionable findings with severity**

**Given:**
- Diff contains plaintext password comparison and unprotected admin route.

**When:** User invokes: "Inspect these files for correctness and security; feedback only."

**Then:**
- Report constant-time comparison risk for password checks with severity/impact.
- Report missing authorization control on admin route with severity.
- Cite exact file locations for each finding.
- Avoid code edits and low-signal style nitpicks.
- Completes in <=5 turns.

## 3. Baseline Comparison
**Scenario:** Inspect a medium patch touching auth and routing.

**Without skill:**
- Messages: 8, User corrections: 3, Tokens: 3,400

**With skill:**
- Messages: 4 (50% reduction), User corrections: 1 (67% reduction), Tokens: 1,900 (44% reduction)

# Success Criteria
- Triggering accuracy: >=90% true positives, <=10% false positives
- Functional correctness: findings are prioritized, actionable, and location-cited
- Safety: 0 write operations
- Efficiency: completes in <=5 turns

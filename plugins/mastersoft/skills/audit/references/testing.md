# Troubleshooting

## Skill doesn't trigger
**Symptom:** `audit` does not activate for security review requests.
**Cause:** Prompt sounds like implementation or generic code review.
**Solution:** Use explicit security-audit phrasing:
- "Audit `src/server` for vulnerabilities with severity ratings."
- "Security review only; no code changes."
- "Check auth/input validation/secrets exposure."

## Skill triggers too often
**Symptom:** `audit` activates for normal refactors/reviews.
**Cause:** Prompt mentions "quality" without security intent.
**Solution:** Add anti-triggers:
- "Fix this bug."
- "Refactor for readability."
- "General review, not security-focused."

## Tool/MCP connection errors
**Symptom:** Audit runs but framework/security references fail.
**Cause:** `mcp__context7` / `mcp__deepwiki` unavailable.
**Solution:**
1. Continue with static repo inspection (`Read/Glob/Grep`, `rg`, `git`, `ls`).
2. Mark uncertain findings as "needs runtime confirmation."
3. Prioritize concrete, reproducible risks over speculative issues.

## Unexpected behavior or errors
**Symptom:** Output is noisy or lacks actionable mitigations.
**Cause:** Findings are generic and not tied to code locations.
**Solution:** Report only concrete risks with severity, exploit path, affected file(s), and specific remediation.

# Test Protocols

## 1. Triggering Tests
**Goal:** `audit` should activate for security-focused review requests and avoid implementation/general QA tasks.

**Should trigger:**
- "Audit `src/api` for injection and auth bypass vulnerabilities."
- "Security review of login and token-refresh flow; no code changes."
- "Scan this service for secret leakage and unsafe deserialization patterns."

**Should NOT trigger:**
- "Fix these security issues directly."
- "Refactor auth module for readability."
- "Run functional tests for user registration."

## 2. Functional Tests
**Test case: Vulnerability triage with severity**

**Given:**
- `src/routes/users.ts` includes an unsanitized SQL query using string interpolation.
- `src/auth/jwt.ts` accepts tokens without issuer/audience validation.

**When:** User invokes: "Audit `src/` for exploitable vulnerabilities with severity and mitigations."

**Then:**
- Report SQL injection risk as High with exploit path and fix guidance.
- Report weak JWT validation as High/Medium with concrete remediation.
- Include exact file locations and impact statements.
- Avoid code edits.
- Completes in <=6 turns.

## 3. Baseline Comparison
**Scenario:** Security audit over one backend module.

**Without skill:**
- Messages: 10, User corrections: 3, Tokens: 4,600

**With skill:**
- Messages: 6 (40% reduction), User corrections: 1 (67% reduction), Tokens: 2,700 (41% reduction)

# Success Criteria
- Triggering accuracy: >=90% true positives, <=10% false positives
- Functional correctness: findings include severity, exploitability, location, mitigation
- Safety: 0 write operations
- Efficiency: completes in <=6 turns

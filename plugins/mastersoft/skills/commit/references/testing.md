# Troubleshooting

## Skill doesn't trigger
**Symptom:** `commit` is skipped when commit creation is requested.
**Cause:** Prompt is interpreted as implementation/debug work.
**Solution:** Use explicit commit intent:
- "Create atomic commits for current changes."
- "Commit with max 3 logical commits."
- "Prepare conventional commits only."

## Skill triggers too often
**Symptom:** `commit` activates during non-commit workflows.
**Cause:** Prompt mentions git context without requesting commit creation.
**Solution:** Add anti-triggers:
- "Show git status only."
- "Review changes, do not commit."
- "Implement/fix code first."

## Tool/MCP connection errors
**Symptom:** Commit flow fails on staging or commit execution.
**Cause:** Git hooks fail, merge conflicts, detached HEAD, or repository state issues.
**Solution:**
1. Resolve repository state blockers (`git status`) before committing.
2. Stage only logical groups; avoid mixed-purpose commits.
3. Use `--no-verify` only when explicitly requested.

## Unexpected behavior or errors
**Symptom:** Commit grouping or message format violates conventions.
**Cause:** Unclear change boundaries or incorrect message language/type.
**Solution:** Re-group by single logical purpose, enforce allowed commit types, and align message language with recent history.

# Test Protocols

## 1. Triggering Tests
**Goal:** `commit` should activate only for preparing and creating commits.

**Should trigger:**
- "Create atomic commits for current staged and unstaged changes."
- "Commit with max 3 logical commits and conventional messages."
- "Prepare commits using `--chore` for maintenance changes."

**Should NOT trigger:**
- "Show me `git status` only."
- "Fix these failing tests before committing."
- "Open a PR for this branch."

## 2. Functional Tests
**Test case: Logical grouping and conventional messages**

**Given:**
- Auth code/test changes are one logical fix; docs update is separate.

**When:** User invokes: "Create atomic commits with `--max=2`."

**Then:**
- Create one `fix:` commit for auth code + tests.
- Create one `docs:` commit for docs changes.
- Use required commit message format (summary + body).
- Respect repository message language convention from recent history.
- 0 git-command failures.
- Completes in <=6 turns.

## 3. Baseline Comparison
**Scenario:** Commit mixed working-tree changes with proper grouping.

**Without skill:**
- Messages: 10, User corrections: 4, Tokens: 4,400

**With skill:**
- Messages: 6 (40% reduction), User corrections: 1 (75% reduction), Tokens: 2,500 (43% reduction)

# Success Criteria
- Triggering accuracy: >=90% true positives, <=10% false positives
- Functional correctness: atomic grouping and valid conventional messages
- Reliability: no repository state violations (conflicts/detached misuse)
- Efficiency: completes in <=6 turns

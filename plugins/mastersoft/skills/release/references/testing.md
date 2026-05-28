# Troubleshooting

## Skill doesn't trigger
**Symptom:** `release` is skipped for release-cut requests.
**Cause:** Prompt is interpreted as generic git/commit operations.
**Solution:** Use explicit release intent:
- "Cut a release with changelog and tag."
- "Release version `x.y.z`."
- "Prepare GitLab release notes and publish."

## Skill triggers too often
**Symptom:** `release` activates for routine development tasks.
**Cause:** Prompt mentions versioning without actual release action.
**Solution:** Add anti-triggers:
- "Just update one commit message."
- "Create branch/PR only."
- "Implement code changes."

## Tool/MCP connection errors
**Symptom:** Release pipeline fails on tagging/publishing.
**Cause:** Missing git/glab auth, signing setup, or remote permissions.
**Solution:**
1. Verify repository state and target branch cleanliness.
2. Validate tag signing and push permissions before release steps.
3. If `glab` is unavailable or unauthenticated, complete local release artifacts (tag) and report the publish blocker.

## Unexpected behavior or errors
**Symptom:** Wrong version bump or incomplete changelog.
**Cause:** Ambiguous commit history or missing explicit version input.
**Solution:** Derive bump from conventional commits when possible, otherwise require explicit `--version`, and review changelog sections before tagging.

# Test Protocols

## 1. Triggering Tests
**Goal:** `release` should activate for versioned release preparation/publishing workflows.

**Should trigger:**
- "Cut release `--version=1.6.0` with changelog and tag."
- "Prepare release from conventional commits and publish GitLab notes."
- "Create scheduled release for current mainline changes."

**Should NOT trigger:**
- "Commit current work only."
- "Open a pull request for this branch."
- "Implement a new payment feature."

## 2. Functional Tests
**Test case: Versioned release execution**

**Given:**
- Last tag: `v1.5.2`.
- Commit history includes `feat:`, `fix:`, and `docs:` entries.
- Repository is clean on release branch.

**When:** User invokes: "Run release with `--version=1.6.0` and publish GitLab release notes."

**Then:**
- Generate/update changelog grouped by change type.
- Create annotated tag `v1.6.0` and push commits/tags.
- Run `glab release create v1.6.0 --notes-file …` when requested.
- Report produced artifacts and publish status.
- 0 git/glab command failures.
- Completes in <=7 turns.

## 3. Baseline Comparison
**Scenario:** Standard minor release with changelog and tag publication.

**Without skill:**
- Messages: 12, User corrections: 4, Tokens: 5,100

**With skill:**
- Messages: 7 (42% reduction), User corrections: 1 (75% reduction), Tokens: 2,900 (43% reduction)

# Success Criteria
- Triggering accuracy: >=90% true positives, <=10% false positives
- Functional correctness: version, changelog, tag, and publish steps all completed
- Reliability: handles auth/signing/push blockers with explicit diagnostics
- Efficiency: completes in <=7 turns

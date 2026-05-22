# QA Output Format

For each finding, provide:
- Severity: `Critical` (data loss / regression) / `High` (test failure) / `Medium` (edge case) / `Low` (style/coverage)
- Location: `file:line` citation
- Reproduction: minimal steps to trigger
- Expected vs actual behavior
- Suggested fix or test to add

Report regression results and flaky tests separately from new findings.

## Regression Protocol

Before declaring any change safe:

1. Run the full test suite (or the relevant subset if suite is large)
2. If any pre-existing test fails, investigate whether the change caused it or it was already broken
3. Report pre-existing failures separately from new failures

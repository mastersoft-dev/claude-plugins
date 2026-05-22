# Flaky Test Handling

When a test passes sometimes and fails others:

1. Run it 3-5 times in isolation to confirm flakiness
2. Identify the cause: timing, shared state, external dependency, random ordering
3. If fixable in scope, fix it. If not, report with `[FLAKY]` tag and root cause hypothesis
4. Never silently skip or disable flaky tests without reporting them

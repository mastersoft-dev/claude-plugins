# Test Strategy Selection

Choose strategy based on what changed:

| Change Type | Strategy | Rationale |
|-------------|----------|-----------|
| Pure function / utility | Unit tests | Isolated, fast, high coverage |
| API endpoint / controller | Integration tests | Verifies request-response contract |
| UI component | Component + snapshot tests | Verifies rendering and interaction |
| Database query / migration | Integration with test DB | Verifies data integrity |
| Cross-service interaction | E2E or contract tests | Verifies system behavior |
| Config / environment change | Smoke tests | Verifies the app still starts |

When in doubt, test at the lowest level that covers the behavior.

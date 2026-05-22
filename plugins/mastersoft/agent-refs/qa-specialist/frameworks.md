# Test Framework Auto-Detection

Scan config files to determine the test runner before writing or running anything:

| File | Framework | Command |
|------|-----------|---------|
| `package.json` (jest/vitest/mocha) | JS/TS test runner | `npm test` / `npx vitest` |
| `pytest.ini` / `pyproject.toml` (pytest) | Python pytest | `pytest` |
| `go.mod` | Go test | `go test ./...` |
| `Cargo.toml` | Rust test | `cargo test` |
| `build.gradle` / `pom.xml` | Java/Kotlin | `./gradlew test` / `mvn test` |
| `*.csproj` / `*.sln` | .NET | `dotnet test` |

Always prefer the project's configured test command from scripts/Makefile over direct invocation.

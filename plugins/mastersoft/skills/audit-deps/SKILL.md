---
name: audit-deps
description: Run a dependency security audit using the right native tool for the detected stack (npm/pnpm/yarn/bun audit, pip-audit, cargo audit, bundle audit, govulncheck, composer audit, etc.). Surface findings, propose remediation, record the audit timestamp so the lint signal stays quiet until the next audit is due. Use when lint-engine signals "Security audit due", on schedule, or proactively.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(command:*), Bash(git:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(bun:*), Bash(pip-audit:*), Bash(safety:*), Bash(pipenv:*), Bash(poetry:*), Bash(cargo:*), Bash(bundle:*), Bash(bundler-audit:*), Bash(govulncheck:*), Bash(composer:*), Bash(mix:*), Bash(dart:*), Bash(flutter:*), Bash(node:*), Bash(mkdir:*), Bash(where:*), PowerShell, AskUserQuestion
argument-hint: "[--fix]"
---

# Audit-Deps

Runs the right native dependency audit tool for the detected stack. Read-only by default. Records the audit timestamp so the lint signal stays silent until the next interval elapses or the lockfile changes.

## Detection → command

| Lockfile / marker | Stack | Command |
|---|---|---|
| `package-lock.json` | npm | `npm audit --json` |
| `pnpm-lock.yaml` | pnpm | `pnpm audit --json` |
| `yarn.lock` | yarn (classic) | `yarn audit --json` |
| `yarn.lock` + berry | yarn (v2+) | `yarn npm audit --json --recursive` |
| `bun.lockb` | bun | `bun audit` (or fall back to `npm audit` via the synced lockfile) |
| `poetry.lock` | poetry | `poetry export --format=requirements.txt | pip-audit -r /dev/stdin --format=json` (requires pip-audit) |
| `requirements.txt` | pip | `pip-audit -r requirements.txt --format=json` |
| `Pipfile.lock` | pipenv | `pipenv check --json` (or `pip-audit`) |
| `Cargo.lock` | cargo | `cargo audit --json` (requires cargo-audit installed) |
| `Gemfile.lock` | bundler | `bundle audit check --update` (requires bundler-audit) |
| `go.sum` | go | `govulncheck ./...` |
| `composer.lock` | composer | `composer audit --format=json` |
| `mix.lock` | mix (elixir) | `mix deps.audit` (if available) |
| `pubspec.lock` | dart/flutter | `flutter pub outdated --json` + `dart pub audit` if available |

## Procedure

1. **Resolve repo root** via `git rev-parse --show-toplevel`. Abort if not a git repo.

2. **Detect stack** — check for lockfile/marker in the order in the table above. If multiple stacks present (monorepo, polyglot), audit each and aggregate.

3. **Tool availability** — POSIX shells: `command -v <tool>`; Windows PowerShell: `Get-Command <tool> -ErrorAction SilentlyContinue` or `where.exe <tool>`. If missing, print a one-line install hint (`brew install …`, `npm i -g …`, `cargo install cargo-audit`, `choco install …`, `winget install …`) and skip that stack with status `skipped (tool missing)`. Cross-platform: pick whichever check the active shell supports.

4. **Run the audit** — for each detected stack, invoke its command. Capture exit code and JSON output. Set a reasonable timeout per call (`timeout 120` if available; otherwise rely on Bash tool timeout).

5. **Parse + summarize**:
   - Count vulnerabilities by severity (low / moderate / high / critical).
   - Top 5 highest-severity entries: package, current version, vulnerable range, fixed version, advisory link.
   - Flag any "high" or "critical" findings.

6. **Output** to stdout:

   ```
   ## Audit summary

   - Stack: <stack>
   - Vulns: <N total> (critical: X, high: Y, moderate: Z, low: W)
   - Top findings:
     1. <package>@<ver>: <advisory title>  → fix: bump to >= <version>
     ...

   ## Recommended remediation

   - `<stack> <auto-fix command>` for auto-fixable (if any)
   - Manual review for the rest
   ```

7. **`--fix` mode** (optional arg): if the stack supports it, run the auto-fix command (`npm audit fix`, `pnpm audit --fix`, `cargo update`, etc.) after a final `AskUserQuestion` "Apply auto-fix?" with options Apply / Skip. Auto-fix may bump versions inside semver-compatible ranges; never use force-fix flags (e.g. `npm audit fix --force`) without explicit user confirmation.

8. **Record timestamp** via the cross-platform helper (no POSIX-only shell idioms):

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/state.js record-audit
   ```

   The helper resolves the canonical repo root, writes `last_audit_at` (millis) under `state.__repos[<repo root>]`, and atomically persists `lint-engine-state.json` in `$CLAUDE_PLUGIN_DATA` (falling back to the OS temp dir on machines where it isn't set). This silences the lint "Security audit due" signal until the lockfile changes again or the audit interval elapses.

## Refusal cases

- Not a git repo → "Run inside a git repo."
- No supported lockfile detected → "No dependency lockfile detected for any supported stack."
- All tools missing → print install hints; record nothing.

## Notes

- **Network access required** for most audits. Will fail in offline CI; document `MASTERSOFT_AUDIT_ENABLED=0` to silence in that case.
- **No secret exfiltration**: never include lockfile contents or environment in any output beyond what the audit tools themselves print.
- **Cadence**: lint signal next-fires when either `<repo>/<lockfile>` mtime exceeds `__last_audit_at` OR `MASTERSOFT_AUDIT_INTERVAL_DAYS` (default 14) elapses. Both configurable via `ORG_RULES.md` frontmatter (`audit_interval_days`, `audit_enabled`).

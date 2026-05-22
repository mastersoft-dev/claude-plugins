---
name: audit
description: Security audit with severity ratings and mitigations. Read-only. For non-security code review use vet.
allowed-tools: Read, Glob, Grep, Bash(rg:*), Bash(git:*), Bash(ls:*), mcp__context7, mcp__deepwiki
argument-hint: "path"
---

Task: Identify security risks in the following files or folders: $ARGUMENTS

## Rules

- List findings with severity (high/medium/low) and mitigation tips.
- Do not modify code.

## Scan Methodology

### 1. Input Tracing
- Trace user input from boundaries (HTTP params, form fields, file uploads) to sinks (DB queries, shell commands, HTML output)
- Flag missing parameterization, encoding, or sanitization at each hop

### 2. Auth and Access
- Check authentication enforcement on all endpoints
- Verify authorization checks (role-based, resource-ownership)
- Look for IDOR (insecure direct object references)

### 3. Secrets and Config
- Scan for hardcoded API keys, tokens, passwords in source and config
- Check .gitignore coverage for sensitive files (.env, credentials)
- Flag permissive CORS, disabled security headers

### 4. Dependencies (with --deps)
- Inspect lock files for known CVEs
- Flag outdated packages with security advisories

## Severity Framework

| Severity | Criteria | Examples |
|----------|----------|----------|
| **Critical** | Exploitable remotely, no auth required | SQLi, RCE, exposed secrets |
| **High** | Exploitable with limited access | Stored XSS, IDOR, auth bypass |
| **Medium** | Requires specific conditions | CSRF, open redirect, info leak |
| **Low** | Minimal impact or hard to exploit | Missing headers, verbose errors |

## Output Format

For each finding, report:
- **Location:** `file:line`
- **Severity:** Critical / High / Medium / Low
- **Category:** OWASP category or CWE
- **Description:** What the vulnerability is
- **Impact:** What an attacker could do
- **Mitigation:** Specific fix recommendation

## Worked Example

User says: "Audit the authentication module for security issues"

1. **Scope** — Read `src/auth/` directory, identify entry points and data flow
2. **Trace inputs** — Follow user credentials from login form -> controller -> DB query
3. **Scan** — Check for: parameterized queries, password hashing, token expiry, CORS config
4. **Finding** — `src/auth/login.ts:42` — string concatenation in SQL query (Critical: SQLi)
5. **Report** — Severity: Critical, Impact: full DB access, Mitigation: use parameterized query

Result: 1 Critical + 2 Medium findings with file:line locations and specific fixes.

## Common Issues

### False positives in pattern-matching
**Cause:** Matching keywords without semantic context.
**Fix:** Verify each finding by tracing the actual data flow; discard if input is trusted/validated upstream.

### Missing dynamic code paths
**Cause:** Dynamic imports, eval, reflection not visible to static analysis.
**Fix:** Note known dynamic patterns and flag them for manual review.

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Identify security risks with severities and mitigations; no code edits.

### Examples
- `audit src/server/`
- `audit pkg/ --strict`

### Checklist
- Catalog findings with High/Medium/Low severity.
- Explain exploitability and practical impact.
- Recommend specific mitigations or references.
- Avoid noisy, generic advice; prefer actionable items.
- Follow industry best practices and standards for the tech stack.

## Flags

- `--deps` Include dependency vulnerability scan/readout (advisories, CVEs)
- `--secrets` Include secret exposure scan/readout (keys, tokens, credentials)

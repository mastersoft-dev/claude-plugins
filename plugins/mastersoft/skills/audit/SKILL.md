---
name: audit
description: Security audit with severity ratings (Blocker/Critical/High/Medium/Low) and mitigations. Read-only. Use proactively when touching auth, authorization, input handling, secrets, or crypto. For non-security code review use vet.
model: opus
effort: xhigh
allowed-tools: Task, Read, Glob, Grep, Bash(rg:*), Bash(git:*), Bash(ls:*), mcp__context7, mcp__deepwiki, PowerShell
argument-hint: "path"
---

Task: Run a security audit on: $ARGUMENTS

This skill is the user-facing entry point. It delegates the scan to the
**security-auditor** agent, which owns the full methodology (input tracing,
auth/access, secrets/config, dependencies, infrastructure, mobile) in its
reference set and applies the shared severity framework
(`agent-refs/security-auditor/severity-framework.md`). Findings return to
this conversation.

## Delegate

Spawn the security-auditor agent, appending any flags (below) to the prompt:

```
Task(subagent_type: "security-auditor", model: "opus",
     prompt: "Security audit. Target: $ARGUMENTS. \
Report each finding with severity (Blocker/Critical/High/Medium/Low), \
`file:line`, OWASP/CWE category, impact, and a specific mitigation. \
Read-only — do not modify code.")
```

## Flags (append to the agent prompt)

- `--deps` Include dependency vulnerability scan (advisories, CVEs)
- `--secrets` Include secret-exposure scan (keys, tokens, credentials)
- `--strict` Safest interpretation; refuse ambiguous ops

## After the agent responds

Return the findings verbatim — do not re-scan, re-rank, or add commentary.
If the agent returns nothing substantive (empty or metadata-only), the
budget was underestimated: retry once with a narrower target, then tell the
user if it still fails.

## Additional Resources

- **`references/testing.md`** — troubleshooting, test protocols, success criteria

## Help

### Synopsis
Identify security risks with severities and mitigations; no code edits.

### Examples
- `audit src/server/`
- `audit pkg/ --strict`

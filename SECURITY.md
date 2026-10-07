# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security reports.

Use [GitHub Security Advisories](https://github.com/mastersoft-dev/claude-plugins/security/advisories/new) to file a private report. Include:

- a short description of the issue
- the file path(s) and version affected
- a minimal reproduction
- the impact you observed

You will get an acknowledgement within 5 business days.

## Supported versions

Only the latest minor release line of each plugin receives security fixes. Older versions are not maintained.

| Plugin | Version | Supported |
|--------|---------|-----------|
| mastersoft | 3.9.x | yes |
| mastersoft | < 3.9 | no |
| relay | 0.1.x | yes |
| timer | 0.1.x | yes |

## Scope

This repository ships hooks, agents, skills, and a statusline that run inside Claude Code on the user's machine. Relay also starts other agent CLIs through herdr or Orca, sends them a prompt built from the session, and writes to the clipboard. Timer runs the `ms` CLI to read GEWEB projects and, after the user confirms, write timesheet activities with the user's own token. Reports we care about include:

- arbitrary code execution via a malicious workspace
- secret exfiltration from `~/.claude/` or the user's environment
- privilege escalation through hook or skill misuse
- path traversal in any helper script
- prompt-injection vectors that bypass the user-approval flow in non-obvious ways

Out of scope:

- Claude Code itself (report to Anthropic)
- third-party MCP servers wired by the user
- the user's own `settings.json` permission choices

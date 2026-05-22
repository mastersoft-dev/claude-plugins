---
name: vet
description: Read-only code review with severity ratings (Blocker/Major/Minor). Use to vet diffs, check before merge, or get quality feedback. For security-only analysis use audit.
model: opus
effort: xhigh
allowed-tools: Read, Glob, Grep
argument-hint: "files_or_folders"
---

Task: Vet the code contained in the appended files and list actionable feedback.

Files or folders: $ARGUMENTS

## Guidelines

- Focus on correctness, clarity, security, and style.
- No code edits -- only comments.
- For dedicated security vulnerability analysis with severity ratings, use `/audit`.

## Review Dimensions

Evaluate in priority order:

1. **Correctness** - Logic errors, off-by-ones, null handling, race conditions, invariant violations
2. **Security** - Injection vectors, unvalidated inputs, leaked secrets, auth gaps
3. **Clarity** - Naming, structure, cognitive complexity, misleading abstractions
4. **Performance** - Obvious N+1 queries, unnecessary allocations, missing early returns
5. **Style** - Consistency with project conventions, formatting, idioms

## Severity Classification

| Level | Meaning | Action |
|-------|---------|--------|
| **Blocker** | Bug, security hole, data loss risk | Must fix before merge |
| **Major** | Logic concern, poor error handling | Should fix before merge |
| **Minor** | Readability, naming, style nit | Nice to fix; optional |
| **Note** | Observation, suggestion, question | FYI; no action needed |

## Output Format

For each finding:
```
### [file:line] Severity: Title
[Explanation]
**Suggestion:** [Concrete fix or alternative]
```

## Worked Example

User says: "Vet the auth module changes"

1. **Read** -- Open all modified files in `src/auth/`
2. **Analyze** -- Check correctness, security, clarity, performance, style
3. **Find** -- `login.ts:42` password compared with `==` instead of timing-safe compare
4. **Report** -- `### [login.ts:42] Blocker: Timing-safe comparison missing` with explanation and suggested fix

Result: 1 Blocker + 2 Minor findings, each with file:line and concrete suggestion.

## Common Issues

### Review too noisy
**Cause:** Reporting style nits alongside real bugs.
**Fix:** Focus on Blocker/Major items first; group Minor/Note items separately at the end.

### Missing broader context
**Cause:** Reviewing a diff without understanding the module.
**Fix:** Read the full file and related imports before commenting.

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Provide a focused, actionable code review.

### Examples
- `vet src/ --files=services/user.ts,api/auth.ts`
- `vet ./patch.diff`

### Checklist
- Correctness: logic, invariants, edge cases.
- Clarity: naming, structure, comments where needed.
- Security: inputs/outputs, secrets, injections.
- Style: consistency with project conventions.
- Prioritize high-signal, concrete suggestions.

---
name: vet
description: Read-only static code review with severity ratings (Blocker/Critical/High/Medium/Low). Use proactively to vet a diff after changes or before merge, or for quality feedback. Does not run code — to run or write tests, use the qa-specialist agent. For security-only analysis use audit. For delegated/parallel review in an isolated subcontext, use the code-reviewer agent.
model: opus
effort: xhigh
allowed-tools: Read, Glob, Grep
argument-hint: "files_or_folders [--terse]"
---

Task: Vet the code contained in the appended files and list actionable feedback.

Files or folders: $ARGUMENTS

## Output mode

Default = full format (below): per-finding explanation + concrete suggestion.

If `--terse` is in $ARGUMENTS, switch to the compressed one-line grammar instead
(same severity tiers, no explanation prose) — for quick pre-merge passes where
scannability beats depth:

```
path:line: <Blocker|Critical|High|Medium|Low>: <problem>. <fix>.
totals: N Blocker, N Critical, N High, N Medium, N Low
```

One line per finding, file order, ascending line numbers. Zero findings →
`No issues.` (For delegated/parallel review, prefer the `code-reviewer` agent
which is haiku-backed and built for this compressed form.)

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
| **Blocker** | Ship-stopper. Halts merge regardless of category. | Must fix before merge |
| **Critical** | Severe bug / security hole / data-loss risk | Must fix before merge |
| **High** | Logic concern, poor error handling, exploitable with limited access | Should fix before merge |
| **Medium** | Conditional bug, readability impact, performance issue | Nice to fix; recommended |
| **Low** | Style nit, observation, suggestion | FYI; optional |

## Output Format

For each finding:
```
### [file:line] Severity: Title
[Explanation]
**Suggestion:** [Concrete fix or alternative]
```

## Worked Example

User says: "Vet the auth module changes"

1. **Read** -- Open the files/folders passed as arguments (here `src/auth/`), or the `.diff` file if one was given — this skill has no git access, so it reviews exactly what it is handed
2. **Analyze** -- Check correctness, security, clarity, performance, style
3. **Find** -- `login.ts:42` password compared with `==` instead of timing-safe compare
4. **Report** -- `### [login.ts:42] Blocker: Timing-safe comparison missing` with explanation and suggested fix

Result: 1 Blocker + 2 Low findings, each with file:line and concrete suggestion.

## Common Issues

### Review too noisy
**Cause:** Reporting style nits alongside real bugs.
**Fix:** Focus on Blocker/Critical items first; group Medium/Low items separately at the end.

### Missing broader context
**Cause:** Reviewing a diff without understanding the module.
**Fix:** Read the full file and related imports before commenting.

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Provide a focused, actionable code review.

### Examples
- `vet src/services/user.ts src/api/auth.ts`
- `vet src/ --terse`
- `vet ./patch.diff`

### Checklist
- Correctness: logic, invariants, edge cases.
- Clarity: naming, structure, comments where needed.
- Security: inputs/outputs, secrets, injections.
- Style: consistency with project conventions.
- Prioritize high-signal, concrete suggestions.

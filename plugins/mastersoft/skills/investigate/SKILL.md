---
name: investigate
description: Read-only root-cause diagnosis, stack-trace triage, and code comprehension. Never modifies code. Use proactively when a bug, crash, failing test, or unexpected behavior needs its root cause found. For quick single-fact lookups use the ask skill.
model: opus
effort: xhigh
allowed-tools: Read, Glob, Grep, Bash(rg:*), Bash(git:*), Bash(ls:*), Task, AskUserQuestion, mcp__context7, mcp__deepwiki, PowerShell
argument-hint: "topic"
---

Task: Investigate $ARGUMENTS

## Read-Only

**NEVER create, edit, or delete any file.** This skill exists to analyze and understand -- not to make changes. Users invoke this skill specifically to prevent code modifications.

## Investigation Protocol

Be thorough. The user invoked this skill because they need real analysis, not surface-level answers.

1. **Explore broadly** -- follow imports, call chains, and references across the codebase. Do not stop at the first file.
2. **Read before answering** -- always read the relevant source files; do not rely on assumptions or memory.
3. **Check documentation** -- use `mcp__context7` / `mcp__deepwiki` when library behavior is relevant.
4. **Cite locations** -- reference findings as `file:line` so the user knows exactly where to look.

## Output

Match output depth to question complexity -- but when in doubt, go deeper rather than shallower.

- Direct answer for simple lookups
- Analysis with findings for debugging/understanding
- Structured sections only for complex cross-cutting investigations

## Worked Example

User says: "Why is the checkout endpoint so slow?"

1. **Read** — Open `src/api/checkout.ts`, trace the handler logic
2. **Follow imports** — `checkout.ts` calls `calculateTax()` from `src/services/tax.ts`
3. **Find bottleneck** — `tax.ts:23` makes a synchronous HTTP call to external API inside a loop (N+1)
4. **Check docs** — Context7: tax API supports batch requests
5. **Report** — "Root cause: `tax.ts:23` — N+1 HTTP calls inside loop. Confirmed: each cart item triggers a separate API call. Suggestion: use batch endpoint."

Result: Bottleneck identified at `tax.ts:23` with actionable fix suggestion; no code modified.

## Common Issues

### Investigation too shallow
**Cause:** Stopped at the first file without following imports and callers.
**Fix:** Always trace at least 2 levels deep: the file with the issue, its callers, and its dependencies.

### Hypotheses presented as facts
**Cause:** Mixing confirmed findings with speculation.
**Fix:** Explicitly label: "Confirmed: X (file:line)" vs "Hypothesis: Y (needs verification)".

## Additional Resources

- **`references/testing.md`** - Troubleshooting, test protocols, and success criteria

## Help

### Synopsis
Investigate problems, debug errors, and explain code with read-only analysis.

### Examples
- `investigate "why is checkout slow"` - Root-cause analysis with file:line citations
- `investigate "explain token refresh flow"` - Code understanding walkthrough
- `investigate "debug this stack trace" --deep` - Deep parallel codebase exploration

### Checklist
- Read relevant source files first - never assume
- Follow imports and call chains across the codebase
- Use Context7/DeepWiki for framework behavior when available
- Cite all findings as file:line references
- Separate facts from hypotheses explicitly
- Never modify code - read-only analysis only

## Flags

- `--explain` Explain what the code does concisely (< 150 words; with `--verbose`: detailed walkthrough)
- `--deep` Nuclear option -- spawn parallel `Task(subagent_type: "Explore")` agents across the codebase, leave no stone unturned, synthesize into a comprehensive report

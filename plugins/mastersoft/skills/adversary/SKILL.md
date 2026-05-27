---
name: adversary
description: Red-team / pre-mortem of a plan, design, decision, architecture, or an "it's done / correct / safe" claim — builds the strongest case AGAINST it, ranked by likelihood × impact. Read-only. Use before committing to an approach: "red-team this plan", "what could go wrong", "poke holes in this", "argue against this". Attacks reasoning, not code lines. For code review use vet, for security vulns use audit, for bug root-cause use investigate.
model: opus
effort: xhigh
allowed-tools: Task, Read, Glob, Grep, Bash(rg:*), Bash(git:*), Bash(ls:*), mcp__context7, mcp__deepwiki, PowerShell
argument-hint: "plan_or_target [--angle security|ops|product] [--parallel]"
---

Task: Red-team the target: $ARGUMENTS

This skill is the user-facing entry point. It delegates the attack to the
**devils-advocate** agent, which owns the full method and the likelihood × impact
ranking — that agent is the single source of the attack lines; do not restate them
here. The case-against returns to this conversation.

## Package the target

The subagent has **no view of this conversation**. Before delegating, decide what
the target is:

- **A path / PR / file** → pass it directly.
- **A plan or decision under discussion** → restate it concisely in the agent prompt:
  the claim, the chosen approach, and the assumptions it rests on. The agent attacks
  what you hand it — if you hand it nothing, it has nothing to break.

## Delegate

```
Task(subagent_type: "devils-advocate", model: "opus",
     prompt: "Red-team this. <TARGET — path, or a concise restatement of the plan/decision \
and its assumptions>. Build the strongest honest case against it, ranked by likelihood × \
impact, grounded in the repo with file:line. Concede what holds up. Read-only.")
```

## Flags (append to the agent prompt)

- `--angle security|ops|product` Focus the attack on one axis instead of all lines.
- `--parallel` Spawn one agent per angle (security, ops, product) and merge the verdicts —
  use when the proposal is large and the angles are independent.

## After the agent responds

Return the verdict and ranked case-against verbatim — do not soften, re-rank, or rebut.
The point is to surface the strongest objections, not to defend the plan. If the agent
returns `SOUND` with nothing to break, say so plainly; do not invent risks to fill space.

## Help

### Synopsis
Adversarial pre-mortem: the strongest case against a plan/decision, ranked, with the one
objection to answer first. No code edits, no redesign.

### Examples
- `adversary "switch session store from Postgres to Redis; assumes <5min data is disposable"`
- `adversary docs/adr/0007-event-bus.md --angle ops`
- `adversary "the new auth flow" --parallel`

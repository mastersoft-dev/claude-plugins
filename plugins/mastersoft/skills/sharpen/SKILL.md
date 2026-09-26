---
name: sharpen
description: Sharpen a task prompt before work starts. Reads the repo from the angles the request's intent calls for, asks only the decisions the repo can't answer, and returns a rewritten, self-contained prompt to copy or run. Use when the user asks to sharpen, refine or improve a prompt, task or request before implementing it. To attack a finished plan use adversary.
argument-hint: "\"<prompt>\" [--run]"
allowed-tools: Read, Grep, Glob, Agent, AskUserQuestion, Bash(git:*)
---

# Sharpen

Turn the request in `$ARGUMENTS` (minus `--run`) into a prompt that a fresh session could run without this conversation. With no request in the arguments, take the user's previous message; with none there either, ask for the request and stop.

Facts come from the repo, decisions come from the user. Steps 1–4 only read: the repo stays as it is until the prompt is final.

## Context

- Repo: !`git rev-parse --show-toplevel 2>/dev/null || echo "not a git repo"`
- Branch: !`git branch --show-current 2>/dev/null || echo "none"`

## 1. Read the intent

State in one line the outcome the user wants and the kind of work. The kind picks the lenses: take the 2–3 the request leans on most, across kinds when it mixes them.

| Kind | Lenses |
|---|---|
| Bug | where it shows (error path, logs); how to reproduce it; which test would pin it |
| Feature | the existing pattern to follow; modules and contracts it touches; where its tests live |
| Refactor | callers and blast radius; tests that guard the behaviour; what must stay stable |
| UI | the design system or reference view; views and states touched; how it gets verified (widths, themes) |
| Infra / ops | where it really runs (host, container, CI); where its config comes from; rollback |
| Docs / rules | the source of truth behind each claim; who reads it |
| Release / process | the repo's own flow (rules files, `CONTRIBUTING.md`, CI config) |

Outside a git repo, skip the lenses that need one and go on with the rest.

## 2. Scout

Give each lens one `scout` agent, all in one message so they run in parallel:

```
Agent(subagent_type: "mastersoft:scout", model: "sonnet", prompt: "Lens: <lens>. Request: <the request in one sentence>. Repo: <root>. Questions: <the lens's questions>.")
```

A lens that one or two Reads answer, you answer yourself. Scout quietly: facts go into the prompt, not into progress messages, so between tool calls write one line at most. Before a fact the prompt leans on goes in, Read its `path:line` and check that the quoted symbol is there. The step is done when every lens has come back with facts or with "nothing found", which is itself a fact for the prompt.

## 3. Ask

Sort what is still open:

- **Fact**: the repo, a command or the docs can settle it → look it up.
- **Decision**: two readings lead to different work → ask it.
- **Ambiguity** that barely changes the work → pick the conservative reading and put it under Assumptions.

Ask decisions with `AskUserQuestion`: up to 4 per round, 2–4 options each, the recommended option first with "(Recommended)", grounded in what the scouting found ("`src/cart.ts:40` already rounds per line"). The recommended option is the smallest reading that delivers what the user asked for: a lookup stays a lookup, and a bigger deliverable is an option the user picks, never the default. Verification is the exception: recommend the check that meets the repo's own bar (its gates, the e2e its rules ask for) whenever it has no external effects. A question that hangs on another open one waits for the next round. Two rounds at most; what is still open after them becomes an assumption. With no decisions open, skip this step.

## 4. Write the prompt

A lookup or a question that the scouting already answers gets the answer, with its `path:line`, instead of a prompt that would search again; offer a prompt only for work that remains.

Write the prompt in the user's language, in one fenced block (four backticks when it holds a code block), with these sections and without the empty ones:

```markdown
<Goal: the outcome in one or two sentences, not the steps>

## Context
- <fact> (`path:line`)

## Decisions
- <what the user chose>

## Constraints
- <a rule this task hinges on> (`AGENTS.md`)

## Scope
- In: <…>
- Out: <…>

## Done when
- <a command and its expected result, a view to check, a test that goes red then green>

## Assumptions
- <each conservative default, to correct before running>
```

- Every line traces to the repo, a rules file or an answer; anything else goes under Assumptions.
- Files, symbols and commands are spelled as the repo spells them.
- The target behaviour is stated positively; a "don't" stays only for a hard guardrail from the rules.
- Rules files load in every session anyway: quote a rule only when this task hinges on it.
- A request that is already sharp comes back nearly as it was, and you say so.

After the block, 2–4 bullets: what the rewrite added or cut compared with the original, and the assumptions most worth checking.

## 5. Hand over

- `--run` in the arguments → run the prompt now as this session's task.
- Otherwise stop after the prompt: the user says to run it, or copies it with `/copy`, which picks the block whole.

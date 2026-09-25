---
name: ask
description: Fast Q&A about codebase, libraries, or concepts. Read-only. Use proactively whenever a targeted question comes up mid-task. Prefer this over the native Explore agent for targeted questions — single-fact lookups, "where is X", "what does Y do", small counts — and reserve Explore for broad multi-location fan-out. For deep root-cause analysis use investigate; for code review feedback use vet.
allowed-tools: Agent
argument-hint: "question"
---

Classify the question, then either answer inline (Direct) or delegate to the ask-explore agent.

## Classification

**Direct** — concept/definition questions, library or framework behavior (use the context7 / deepwiki MCP tools), or anything answerable from the current conversation context. **Answer inline; do NOT spawn `ask-explore`.** No repo search needed, so the extra hop is pure latency.

**Repo lookup** — single-fact lookups, definitions, "where is X", "what does Y do", small counts, or a multi-file question scoped to this repo:

```
Agent(subagent_type: "mastersoft:ask-explore", model: "haiku", prompt: "Read-only Q&A — answer only, never edit or create files. Question: $ARGUMENTS")
```

The turn budget is fixed by the agent's `maxTurns` frontmatter; the `Agent` tool takes no turn parameter.

## Retry on empty response

If the agent returns **no substantive answer** (empty output, metadata only, or a response that clearly doesn't answer the question), retry **once** with `model: "sonnet"` and the question narrowed to the part that went unanswered. If that also fails, stop and tell the user:

> "The ask-explore agent couldn't answer within its budget. Try rephrasing as a narrower question, or use the Explore agent for deep research."

## After a successful response

**STOP.** Return the agent's response verbatim. Do NOT:
- Do additional research yourself
- Spawn any other agents (Explore, general-purpose, etc.)
- Read files, run commands, or do follow-up work
- Add commentary or re-process the answer

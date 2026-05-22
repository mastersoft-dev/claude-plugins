---
name: ask
description: Fast Q&A about codebase, libraries, or concepts. Read-only. For deep root-cause analysis use investigate; for code review feedback use vet.
model: haiku
argument-hint: "question"
---

Classify the question, then delegate to the ask agent.

## Classification

**Simple** — single-fact lookups, definitions, "where is X", "what does Y do", small counts:

```
Task(subagent_type: "ask", model: "haiku", prompt: "$ARGUMENTS")
```

**Complex** — multi-file analysis, project status, cross-cutting concerns, "what's next", architectural questions:

```
Task(subagent_type: "ask", model: "haiku", max_turns: 50, prompt: "$ARGUMENTS")
```

## Retry on empty response

If the agent returns **no substantive answer** (empty output, metadata only, or a response that clearly doesn't answer the question), the budget was underestimated. Retry with escalation:

1. **First retry** — double the budget, same model:
   - Simple: `max_turns: 30, model: "haiku"`
   - Complex: `max_turns: 100, model: "haiku"`
2. **Second retry** — upgrade model + max budget:
   - `max_turns: 100, model: "sonnet"`
3. **After second retry fails** — stop and tell the user:
   > "The ask agent couldn't answer within its budget. Try rephrasing as a narrower question, or use the Explore agent for deep research."

Do NOT skip straight to retry #2. Always try the cheaper escalation first.

## After a successful response

**STOP.** Return the agent's response verbatim. Do NOT:
- Do additional research yourself
- Spawn any other agents (Explore, general-purpose, etc.)
- Read files, run commands, or do follow-up work
- Add commentary or re-process the answer

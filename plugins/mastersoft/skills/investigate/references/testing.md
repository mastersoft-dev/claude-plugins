# Troubleshooting

## Skill doesn't trigger
**Symptom:** `investigate` is not selected for analysis tasks.
**Cause:** Prompt implies implementation instead of read-only investigation.
**Solution:** Use read-only analysis phrasing:
- "Investigate why checkout latency spiked; no code changes."
- "Explain how token refresh works in this repo."
- "Debug this stack trace and cite file:line references only."

## Skill triggers too often
**Symptom:** `investigate` activates when user wants code changes.
**Cause:** Prompt mixes debugging language with implementation intent.
**Solution:** Add anti-triggers:
- "Fix it now."
- "Implement the patch."
- "Modify files to resolve this bug."

## Tool/MCP connection errors
**Symptom:** Investigation quality drops due to tool restrictions.
**Cause:** Missing read/search commands, `Task` unavailable for deep mode, or disconnected MCP servers.
**Solution:**
1. Verify read-only command access (`rg`, `git`, `ls`).
2. For `--deep`, ensure `Task` delegation is available.
3. Reconnect MCP servers for library/spec clarification.
4. If tools are limited, report confidence level and cite only verified local findings.

## Unexpected behavior or errors
**Symptom:** Output is shallow, speculative, or missing citations.
**Cause:** Stopping at first file, no call-chain tracing, no `file:line` evidence.
**Solution:**
1. Expand search through imports/references and execution path.
2. Read relevant source before conclusions.
3. Include concrete `file:line` citations for each finding.
4. Separate facts from hypotheses explicitly.

# Test Protocols

## 1. Triggering Tests
**Goal:** `investigate` should activate for read-only debugging/analysis and avoid write-oriented tasks.

**Should trigger:**
- "Investigate why checkout latency spiked after yesterday's merge; no code edits."
- "Debug this stack trace and cite exact `file:line` causes."
- "Explain how token refresh works across API and mobile clients."

**Should NOT trigger:**
- "Fix checkout latency and patch the code now."
- "Refactor token refresh module for clarity."
- "Write a new authentication middleware."

## 2. Functional Tests
**Test case: Root-cause analysis with citations only**

**Given:**
- `src/cache/session-cache.ts` allocates a new `setInterval` on every call.
- `startEviction()` is called on every request path in `src/server.ts`.

**When:** User invokes: "Investigate the memory leak; read-only, cite where the leak is introduced."

**Then:**
- Identify repeated interval allocation as the likely leak source.
- Cite concrete evidence with `file:line` references.
- Provide hypotheses and confidence levels separately.
- Suggest actionable next steps; do not apply changes.
- Perform 0 file writes/edits/deletes.
- Completes in <=6 turns.

## 3. Baseline Comparison
**Scenario:** Diagnose a cross-file runtime issue without modifying code.

**Without skill:**
- Messages: 11, User corrections: 4, Tokens: 4,800

**With skill:**
- Messages: 6 (45% reduction), User corrections: 1 (75% reduction), Tokens: 2,700 (44% reduction)

# Success Criteria
- Triggering accuracy: >=90% true positives, <=10% false positives
- Functional correctness: root cause and evidence reported with `file:line` citations
- Safety: 0 write operations in read-only mode
- Efficiency: completes in <=6 turns

# Stage 3: Self-Review Pass

Re-read the document with fresh eyes to catch what an outside reader would stumble on. Do NOT spawn subagents — subagent-from-subagent is not supported in Claude Code.

## Protocol

1. Read the full document top-to-bottom without referring back to your conversation context.
2. For each section, write down (mentally, not in the doc):
   - What would a first-time reader misinterpret here?
   - What assumption am I making that the reader may not share?
   - Is the intent obvious in one read, or does it require a second pass?
3. List 5-10 questions a realistic reader would ask after reading the doc.
4. For each question, check whether the doc actually answers it. Flag gaps.
5. Surgical fixes: edit only the sections with identified gaps. Do not rewrite.
6. Re-read once more. Exit when no new gaps surface.

## Exit Criteria

- Every question from step 3 has a clear answer in the doc OR is explicitly out-of-scope.
- No ambiguity remains in the doc's primary instructions.
- No section requires a second pass to grasp the intent.

## Output

After self-review, report:
- Total gaps found and fixed
- Any unresolved gaps the caller (human author) must address
- List under `## Open Questions for Author`

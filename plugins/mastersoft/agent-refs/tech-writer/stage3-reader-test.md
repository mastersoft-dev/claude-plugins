# Stage 3: Reader Testing

Test the doc with a fresh context to catch blind spots.

1. Predict 5-10 questions readers would realistically ask.
2. Spawn a subagent with just the document content and each question (no conversation context).
3. Check for ambiguity, false assumptions, contradictions via separate subagent.
4. Report what the reader-agent got wrong.
5. Fix gaps by looping back to refinement.

Exit when reader-agent consistently answers correctly with no new gaps.

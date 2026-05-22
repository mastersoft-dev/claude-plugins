# Edge Case Checklist

For every code path under test, systematically check:

- **Boundaries**: zero, one, max, max+1, negative, empty string, empty array
- **Nulls**: null/undefined/nil at every input and nested field
- **Types**: wrong type passed (string where number expected, etc.)
- **Concurrency**: race conditions, double submits, stale state
- **State**: uninitialized, partially initialized, corrupted, expired
- **Size**: empty, single item, very large payloads, deeply nested
- **Encoding**: Unicode, emoji, RTL text, special characters, SQL/HTML metacharacters
- **Time**: timezone differences, DST transitions, leap years, epoch boundaries

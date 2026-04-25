# Fix silent test skipping in parser tests

## Problem

Parser tests use `if (result.success)` guards that silently skip all meaningful assertions when parsing fails:

```typescript
expect(result.success).toBe(true);
if (result.success) {
  expect(result.result.type).toBe("blockArgument"); // skipped if parse fails
  expect(result.result.params).toHaveLength(1);      // skipped if parse fails
}
```

If parsing fails, only the first `expect` fails with a generic "expected false to be true" — no indication of what went wrong.

## Fix

Add a helper that narrows the type and fails with the parser's error message:

```typescript
function assertSuccess(result) {
  expect(result.success, `Parse failed: ${result.expected ?? "unknown error"}`).toBe(true);
  return result.result;
}
```

Then replace the pattern:

```typescript
// Before
const result = inlineBlockParser(input);
expect(result.success).toBe(true);
if (result.success) {
  expect(result.result.type).toBe("blockArgument");
}

// After
const result = assertSuccess(inlineBlockParser(input));
expect(result.type).toBe("blockArgument");
```

## Scope

This pattern is used across all parser test files in `lib/parsers/*.test.ts`. Could be fixed incrementally — start with `blockArgument.test.ts` and expand.

# Array Slice Syntax Design

## Overview

Add Python-style array slice syntax (`arr[start:end]`) to Agency, compiling to JavaScript's `.slice()` method. Works on both arrays and strings. Supports optional chaining.

## Syntax

```
arr[start:end]    // both bounds
arr[start:]       // from start to end
arr[:end]         // from beginning to end
arr[:]            // copy entire array/string
arr[-2:]          // negative indices
arr?.[1:3]        // optional chaining
```

The `:` inside brackets distinguishes slicing from indexing. Both `start` and `end` are optional expressions.

## Compiled Output

| Agency | TypeScript |
|--------|-----------|
| `arr[1:3]` | `arr.slice(1, 3)` |
| `arr[1:]` | `arr.slice(1)` |
| `arr[:3]` | `arr.slice(0, 3)` |
| `arr[:]` | `arr.slice()` |
| `arr[-2:]` | `arr.slice(-2)` |
| `arr?.[1:3]` | `arr?.slice(1, 3)` |

When `start` is omitted and `end` is present, `0` is passed as the first argument. When both are omitted, no arguments are passed. This matches Python's semantics and leverages JS's built-in `Array.prototype.slice` / `String.prototype.slice`.

## Scope

- Arrays and strings only (both supported by JS `.slice()`).
- No step parameter (`arr[::2]`) — not built into JS.
- No slice assignment (`arr[1:3] = [10, 20]`) — not straightforward in JS.
- No type checker changes for now.

## Design: New AST Node

### AST Type

Add a `"slice"` kind to `AccessChainElement` in `lib/types/access.ts`:

```typescript
export type AccessChainElement =
  | { kind: "property"; name: string; optional?: boolean }
  | { kind: "index"; index: Expression; optional?: boolean }
  | { kind: "slice"; start?: Expression; end?: Expression; optional?: boolean }
  | { kind: "methodCall"; functionCall: FunctionCall; optional?: boolean };
```

### Parser

Add a `sliceChainParser` in `lib/parsers/parsers.ts` alongside `indexChainParser`:

- Parses `[start?:end?]` inside brackets.
- The `:` is the key disambiguator — if the parser sees `:` inside `[...]`, it's a slice, not an index.
- `start` and `end` are both optional, parsed by `exprParser`.
- Supports optional chaining via the existing `bracketParser` (handles `?.[`).
- `chainElementParser` tries `sliceChainParser` before `indexChainParser`, since `indexChainParser` would otherwise consume `start` and fail on `:`.

### Builder

Add a `"slice"` case to `processValueAccess` in `lib/backends/typescriptBuilder.ts`:

- Builds a `.slice(start, end)` method call using existing IR helpers (`ts.prop()`, `ts.call()`).
- When `start` is omitted and `end` is present, passes `0` as the first argument.
- Handles optional chaining by passing `{ optional: true }` to `ts.prop()`.

No new IR nodes needed.

## Testing

- **Parser unit tests** in `lib/parsers/access.test.ts` — test all slice variants and verify AST shape.
- **Integration test fixtures** in `tests/typescriptGenerator/` — `.agency` file with slice expressions and expected `.mts` output.
- **Agency execution tests** in `tests/agency/` — run slicing on arrays and strings to verify runtime behavior.

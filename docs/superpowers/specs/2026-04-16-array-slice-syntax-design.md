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

Also add a `"slice"` case to `processValueAccessPartial` (used for pipe expression processing) with the same logic.

No new IR nodes needed.

### Tree Walker

Update `walkNodes()` in `lib/utils/node.ts` to handle the `"slice"` kind. This function dispatches on `element.kind` for `AccessChainElement` at two locations (assignment access chains and valueAccess chains). Add an `else if (element.kind === "slice")` branch at both sites to walk `element.start` and `element.end` when present. Without this, variables used inside slice bounds (e.g., `arr[0:n]`) would not be visited during scope resolution in the preprocessor.

### Formatter

Update `processAccessChainElement()` in `lib/backends/agencyGenerator.ts` to handle the `"slice"` kind. This function formats access chain elements back to Agency source code and has a `default` case that throws for unknown kinds. Without a `"slice"` case, formatting any Agency code containing slice syntax will throw.

## Notes

- Chained slices like `arr[1:3][0:1]` work naturally — each `.slice()` returns an array/string, and the next chain element operates on the result.
- `arr[:]` produces a shallow copy for arrays (not deep copy). This matches JS `.slice()` behavior.
- Non-integer indices (e.g., `arr[1.5:3]`) are not validated since there are no type checker changes. JS `.slice()` will truncate floats.

## Testing

- **Parser unit tests** in `lib/parsers/access.test.ts` — test all slice variants (`[1:3]`, `[1:]`, `[:3]`, `[:]`, `[-2:]`, `?.[1:3]`) and verify AST shape.
- **Integration test fixtures** in `tests/typescriptGenerator/` — `.agency` file with slice expressions and expected `.mts` output.
- **Agency execution tests** in `tests/agency/` — run slicing on arrays and strings, including chained slices (`arr[1:3][0:1]`), expression bounds (`arr[0:n]`), and negative indices (`arr[-1:]`, `arr[:-1]`).

# Inline Block Syntax Design

## Summary

Add a new terse inline block syntax (`\x -> expr`) for passing blocks as function arguments, alongside the existing trailing `as` syntax. The new syntax places the block inside the function call parentheses and supports implicit-return expression bodies.

## Motivation

The current `as` syntax is verbose for simple operations like map/filter:

```
const arr2 = map(arr) as x {
  return x + 1
}
```

The new syntax makes one-liners concise:

```
const arr2 = map(arr, \x -> x + 1)
```

## Syntax

### New inline block forms

```
// Single param, expression body (implicit return)
map(arr, \x -> x + 1)

// Multi param, expression body (parens required for multiple params)
mapWithIndex(arr, \(x, i) -> x + i)

// No params
sample(5, \ -> "hello")

// Single param, statement body (explicit return required)
map(arr, \x -> {
  const y = x + 1
  return y
})

// Multi param, statement body
mapWithIndex(arr, \(x, i) -> {
  const y = x + i
  return y
})
```

### Existing trailing syntax (unchanged)

```
map(arr) as x {
  return x + 1
}

retry(3) as (prev, attempt) {
  return attempt + 1
}

sample(5) as {
  return "hello"
}
```

### Rules

1. **Inline blocks can only appear as function call arguments.** They are parsed only inside function call argument lists. They cannot be assigned to variables or used as standalone expressions.
2. **Expression bodies implicitly return.** `\x -> x + 1` wraps the expression in a synthetic return node. Statement bodies (with `{ }`) require explicit `return`.
3. **Parens required for multiple params.** Single param: `\x -> ...`. Multiple params: `\(x, i) -> ...`. No params: `\ -> ...`.
4. **Both syntaxes produce the same AST node** (`BlockArgument`), so the builder, type checker, and runtime require no changes.

## Implementation

### Parser changes

**New parser: `inlineBlockParser`** in `lib/parsers/parsers.ts`

Parses `\ [params] -> expr_or_block`:
- Starts with `\` character (unambiguous prefix, no backtracking). Note: `\` is not currently a valid expression start in Agency (it only appears inside string/regex literals), so this is unambiguous today. This is a deliberate syntax choice inspired by Haskell's lambda syntax.
- Params: either `(p1, p2, ...)` for multiple, a single identifier, or nothing (for `\ ->`)
- `->` arrow separator
- Body disambiguation: the parser tries **statement block first** (looks for `{` followed by statements), then falls back to **expression**. This resolves the `{` ambiguity between object literals and statement blocks — statement block wins. This matches the existing `as` block behavior where `{` always starts a block body.
- For expression bodies: the expression parser naturally stops at `,` and `)` because these are not binary operators in Agency's `buildExpressionParser`. The expression `x + 1` in `\x -> x + 1, 42)` terminates at the comma because `sepBy` handles the comma as a separator between arguments, not as part of the expression. No special expression-termination logic is needed.
- Expression bodies are wrapped in a synthetic `return` statement node to produce the same `body: AgencyNode[]` structure as statement blocks.
- Type annotations on inline block params are not supported (same as existing `as` blocks — types come from the function signature).

**Wire into function call parser:**

Add `inlineBlockParser` as an alternative in the function call argument list's `sepBy`, alongside `namedArgumentParser`, `splatParser`, and `exprParser`. It must be tried before `exprParser` since `\` is not a valid expression start.

When an inline block is parsed as an argument within `sepBy`, the function call parser post-processes the argument list: it scans for the `BlockArgument` node, removes it from the `arguments` array, and moves it to the `FunctionCall.block` field. This approach lets the inline block participate naturally in `sepBy`'s comma-separated parsing while producing the same `FunctionCall` structure the builder expects.

**Only one block per call.** If the parser finds more than one `BlockArgument` in the argument list (or an inline block plus a trailing `as` block), it should produce a parse error. A function call may have at most one block.

**Inline blocks can appear at any argument position.** Unlike the trailing `as` which is always after the closing `)`, an inline block can be the first, middle, or last argument. Positional information is not lost because the builder always places the block as the last positional arg to the callee regardless of where it appears syntactically.

**Keep existing `blockArgumentParser`** for the trailing `as` syntax — no changes needed.

### AST changes

None. `BlockArgument` already has `params: FunctionParameter[]` and `body: AgencyNode[]`. Expression bodies become a single-element `body` array containing a `return` statement node wrapping the parsed expression.

### Builder changes

None. `processBlockArgument()` in `typescriptBuilder.ts` already converts any `BlockArgument` into an `AgencyFunction` positional argument. Both syntaxes produce the same AST, so the same code path handles both.

### Type checker changes

None expected. The type checker validates block params against the function signature's block type. Since the AST is identical, existing checks apply.

### Symbol table and collectProgramInfo changes

None. These phases operate on `BlockArgument` nodes which are unchanged. The inline block produces the same AST, so no changes are needed in `buildSymbolTable` or `collectProgramInfo`.

### Preprocessor changes

None expected. The preprocessor operates on `BlockArgument` nodes regardless of how they were parsed.

### Formatter changes

Out of scope for the initial implementation. The `AgencyGenerator` formatter will need to be updated to emit the inline block syntax, but this can be done as a follow-up. Initially, formatting an inline block may round-trip it to the trailing `as` form.

## Testing

### Parser unit tests

Add to `lib/parsers/blockArgument.test.ts`:
- `\x -> x + 1` — single param expression body
- `\(x, i) -> x + i` — multi param expression body
- `\ -> "hello"` — no param expression body
- `\x -> { return x + 1 }` — single param statement body
- `\(x, i) -> { return x + i }` — multi param statement body
- Function call with inline block: `map(arr, \x -> x + 1)`
- Function call with other args and inline block: `foo(1, "bar", \x -> x + 1)`
- Inline block as non-last argument: `foo(\x -> x + 1, 42)` — allowed, block is moved to `FunctionCall.block` regardless of position
- **Negative tests:**
  - Two inline blocks in one call: `foo(\x -> x + 1, \y -> y * 2)` — should produce parse error
  - Inline block plus trailing `as` block: `map(arr, \x -> x + 1) as y { return y }` — should produce parse error

### Integration test fixtures

Add to `tests/typescriptGenerator/`:
- `inlineBlockBasic.agency` / `.mjs` — inline block with expression body
- `inlineBlockParams.agency` / `.mjs` — inline block with multiple params

### Agency execution tests

Add to `tests/agency/blocks/`:
- `block-inline-basic.agency` / `.test.json` — inline block with expression body runs correctly
- `block-inline-params.agency` / `.test.json` — inline block with multiple params
- `block-inline-statement.agency` / `.test.json` — inline block with statement body
- `block-inline-interrupt.agency` / `.test.json` — inline block that interrupts and resumes correctly

## Edge cases

- **Multiple blocks in one call:** A function call may have at most one block (whether inline or trailing). Two inline blocks or an inline block plus a trailing `as` block produce a parse error.
- **Nested inline blocks:** `map(arr, \x -> filter(x.items, \y -> y > 0))` — works naturally since the inner block is inside a nested function call's argument list, which is a separate parsing context.
- **Block as non-last argument:** `foo(\x -> x + 1, 42)` — allowed. The inline block can appear at any argument position. The parser post-processes to move it to `FunctionCall.block`.
- **Expression body precedence:** In `\x -> x + 1, 42)`, the expression body is `x + 1`. The comma terminates the expression naturally because `,` is not a binary operator in Agency's expression parser. `sepBy` handles the comma as an argument separator. No special termination logic needed.
- **`{` ambiguity (object literal vs statement block):** After `->`, the parser tries statement block first, then expression. So `\x -> { ... }` is always a statement block. To pass an object literal as the expression body, users would need to wrap it: `\x -> ({ key: value })`. This matches the behavior of JavaScript arrow functions and is unlikely to arise in practice since blocks typically return computed values, not object literals.
- **Type annotations on params:** Not supported. Types are inferred from the function signature, same as the existing `as` syntax. `\(x: number) -> x + 1` is a parse error.

# CI Failure: Block closure over outer-scope `let`/`const` variables

## Summary

Blocks that capture and mutate a `let`/`const` variable from the enclosing function/node scope get incorrect codegen. The variable is treated as block-local instead of referencing the outer scope, so mutations don't persist across block invocations.

## Failing test

`tests/integration/stdlib-sandbox/strategy.agency` — the "stdlib sandbox: strategy" CI step.

Expected output: `"strategy ok"`
Actual output: `"retry failed"`

## Example code

```ts
import { retry } from "std::strategy"

def isGreaterThan2(x: any): boolean {
  return x > 2
}

node main() {
  let attempts = 0
  const retryResult = retry(5, isGreaterThan2) as {
    attempts = attempts + 1
    return attempts
  }
  if (retryResult != 3) {
    return "retry failed"
  }
  return "strategy ok"
}
```

The block passed to `retry` closes over `attempts`, which is declared with `let` in the outer node scope. Each invocation of the block should increment the same `attempts` variable. After three calls, `attempts` should be 3, which passes the `isGreaterThan2` test.

Instead, each block invocation gets its own fresh `attempts` (starting as `undefined`), so `attempts + 1` evaluates to `NaN`, the test function never passes, and `retry` returns `null`. The check `retryResult != 3` is true, so the node returns `"retry failed"`.

## Root cause

Phase ordering bug in `lib/preprocessors/typescriptPreprocessor.ts`, in the scope resolution logic that runs on every function/node body.

### How scope resolution works

There are two phases:

1. **Phase 1** (line ~1531): Resolves variables inside block bodies. For each variable referenced in a block, it calls `lookupScope(nodeName, varName)` to check whether the variable exists in the enclosing scope. If `lookupScope` returns `null`, the variable is treated as a new block-local variable and given scope `"block"`.

2. **Phase 2** (line ~1573): Resolves variables in the function/node body. When it encounters a `let`/`const` declaration, it registers the variable name in `localVarsInFunction[nodeName]` and gives it scope `"local"`.

### The bug

`lookupScope` checks `localVarsInFunction[nodeName]` to find local variables, but `localVarsInFunction[nodeName]` is an empty `Set` when Phase 1 runs — because Phase 2 (which populates it) hasn't executed yet.

So when Phase 1 processes the block and encounters `attempts`:

1. It calls `lookupScope(nodeName, "attempts")`.
2. `localVarsInFunction[nodeName]` is empty, so `lookupScope` returns `null`.
3. Because `lookupScope` returned `null`, `attempts` is added to `blockLocalNames`.
4. All references to `attempts` inside the block get scope `"block"`.

### Effect on generated code

With scope `"block"`, the variable compiles to `__bstack.locals.attempts` instead of `__stack.locals.attempts`. Each block invocation creates a new `__bstack` via `setupFunction()`, so `__bstack.locals.attempts` starts as `undefined` every time. The outer node's `__stack.locals.attempts` is never read or written by the block.

## Fix

Pre-register `let`/`const` declarations from the function/node body into `localVarsInFunction[nodeName]` **before** Phase 1 runs. This way, when Phase 1 calls `lookupScope` for a variable that was declared in the outer scope, it correctly finds it and assigns scope `"local"` instead of `"block"`.

Care must be taken to only collect declarations from the function body itself, not from inside block bodies — a `let` inside a block should still be block-local.

# Pipe receiver lowering does not mirror `processValueAccess` precedence handling

## Summary

`PipeChainEmitter.processValueAccessPartial` (in
`lib/backends/typescriptBuilder/pipeChainEmitter.ts`) walks all but the
last element of a `ValueAccess` chain to build the **receiver** that pipe
lowering then passes to `__callMethod(receiver, propName, ...)`.

Its chain-walk logic was moved verbatim from the old
`TypeScriptBuilder.processValueAccessPartial` and is **missing four
things** that the main `TypeScriptBuilder.processValueAccess` does:

1. Wrapping a `functionCall` base in parens after awaiting it.
2. Wrapping any non-trivial base (binOp, tryExpression, newExpression,
   unary, object/array literal, etc.) in parens before applying the
   chain.
3. Propagating the `optional` flag to `ts.prop` / `ts.index` /
   `ts.prop("slice")`.
4. Handling the `call` chain element kind at all (it currently has no
   `case "call":` branch — it falls through and just returns the
   pre-call result).

## Why it has not bitten anyone yet

Pipe lowering only calls `processValueAccessPartial` when the **last**
chain element is a bare property or method reference (the "no
placeholder" branch in `buildPipeLambda` / `buildPipeStageBody`). So
the broken path only fires for receivers like:

- `getObj().foo |> stage` (awaited functionCall base + chain)
- `(makeObj()).foo |> stage` (non-trivial base + chain)
- `obj?.foo.bar |> stage` (optional chain on receiver)
- `factories.makeOne().bar |> stage` (intermediate `call` element)

None of the current pipe fixtures
(`tests/agency/result/pipe-*`, `tests/agency/dynamic-functions/pipe-*`,
`tests/agency/partial-application-pipe.*`) exercise any of those
shapes. Bare-variable receivers and single-property receivers (the
common shapes) bypass the buggy code paths entirely.

## Concrete bug example

For `getObj().foo.bar |> stage`:

- The base is a `functionCall`, so `processNode(base)` returns the IR for
  `await getObj()`.
- `processValueAccessPartial` then loops over `chain[0]` (`.foo`) and
  emits `ts.prop(awaitNode, "foo")`.
- Pretty-printed, that comes out as `await getObj().foo`, which JS
  parses as `await (getObj().foo)` — i.e. `.foo` is read off the
  unresolved Promise, then awaited. We then hand that to
  `__callMethod(receiver, "bar", ...)` and method lookup happens on the
  Promise.

`TypeScriptBuilder.processValueAccess` avoids this by emitting
`(await getObj()).foo` (parens added explicitly via `ts.raw` after the
await).

## Suggested fix

Either:

- **A. Share the chain-walk.** Refactor `processValueAccess` to expose a
  helper that takes `(base: TsNode, chain: AccessChainElement[])` and
  reuse it from `processValueAccessPartial` with `chain.slice(0, -1)`.
  This is the safest fix: one source of truth for chain lowering.

- **B. Mirror the logic locally.** Copy the four behaviors listed above
  into `processValueAccessPartial`. Cheaper diff but creates the same
  drift risk we just paid down.

(A) is preferred.

## Fixtures to add alongside the fix

In `tests/agency/result/` or similar, add at least these pipe fixtures
so the regression is locked in:

1. `pipe-receiver-awaited-call.agency` — `getObj().foo |> stage`
2. `pipe-receiver-non-trivial-base.agency` — `(a ? b : c).foo |> stage`
   or `new Foo().bar |> stage`
3. `pipe-receiver-optional.agency` — `obj?.foo |> stage` and
   `arr?.[i] |> stage`
4. `pipe-receiver-intermediate-call.agency` — `factories.makeOne().bar |> stage`

Each should round-trip a value through the pipe and exact-match the
expected output, so a regression in receiver lowering surfaces as a
runtime mismatch (or a TypeError on "cannot read property X of
Promise").

## Origin

Raised by Copilot review on
[PR #165](https://github.com/egonSchiele/agency-lang/pull/165) — the
PR that extracted `PipeChainEmitter`. Intentionally deferred so the
extraction stayed a no-behavior-change refactor.

# `thread {}` as an Agency stdlib function

**One-line summary:** Replace the hand-rolled `thread {}` parser + bespoke AST/IR/codegen path with a desugaring into a stdlib function call (`__internal_thread(opts, block)`), so adding a new named argument becomes a one-line stdlib change instead of a fan-out across five files.

**Status:** Proposed (follow-up to PR #225). NOT part of PR #225.

> ⚠️ This document is a **follow-up proposal** captured during PR #225 review. It is intentionally out of scope for that PR. Filing it here so the idea isn't lost.

---

## Problem

The current `thread {}` block is parsed by a hand-rolled parser ([`_threadNamedArgsParser` in `lib/parsers/parsers.ts`](../../../lib/parsers/parsers.ts)) and lowered through a bespoke pipeline. As a result:

- Bad argument names produce a parse-time error message that lives inside the parser ("Unknown thread argument: foo. Allowed: label, summarize, ..."). That string is awkward to maintain and drifts every time the allowed-arg list changes.
- The AST node ([`MessageThread` in `lib/types/messageThread.ts`](../../../lib/types/messageThread.ts)) carries five+ optional `Expression` fields (`label`, `summarize`, `continueExpr`, `sessionExpr`, and — as of PR #225 — `hidden`) that have to be plumbed through:
  1. the parser (`_threadNamedArgsParser`),
  2. the AST type (`MessageThread`),
  3. the IR (`TsRunnerThread`),
  4. the codegen emitter ([`processMessageThread` in `lib/backends/typescriptBuilder.ts`](../../../lib/backends/typescriptBuilder.ts)),
  5. the IR pretty-printer ([`lib/ir/prettyPrint.ts`](../../../lib/ir/prettyPrint.ts)), and
  6. the `Runner.thread` runtime entry.

So every new named argument is a five-file edit. **Concrete example: the `hidden` arg added in PR #225** required touching exactly that fan-out — the most recent demonstration of the cost.

---

## Proposal

`thread {}` becomes pure syntactic sugar for a stdlib function call. The source (current syntax — unchanged):

```agency
thread(label: "x", hidden: true) {
  // body
}
```

is rewritten by the parser into:

```agency
__internal_thread({ label: "x", hidden: true }, () => {
  // body
})
```

- `__internal_thread` is a stdlib `def` declared in `stdlib/threads.agency` (or similar), with a typed `opts: ThreadOpts` parameter and a block parameter. See the [block-arg semantics](https://agency-lang.com/guide/blocks.html) for the existing block-parameter calling convention.
- The parser does ONE thing: rewrite `thread <args> { body }` into a function-call AST. After that the **existing function-call pipeline** handles type checking, codegen, and runtime dispatch — no `thread`-specific code paths.

`subthread {}` follows the same pattern via a separate `__internal_subthread(opts, block)`.

---

## What survives

- `Runner.thread(id, method, opts, callback)` — still the runtime primitive that pushes/pops the active stack, fires `onThreadStart` / `onThreadEnd`, and tracks the per-call substep counter.
- The `ThreadStepOpts` type — same shape, just consumed by `__internal_thread` instead of by codegen.
- All existing tests for thread isolation, messaging, `continue`, `session`, and `hidden`.

---

## What goes away

- The `_threadNamedArgsParser` parser and its "unknown thread argument" error (becomes a normal "no such field on `ThreadOpts`" type error).
- The `MessageThread` AST node's optional argument fields. The AST node itself may remain for the source-to-source rewriter to attach a marker, but the named-arg slots become dead weight.
- The codegen branch in [`processMessageThread` in `lib/backends/typescriptBuilder.ts`](../../../lib/backends/typescriptBuilder.ts#L2767) that processes `label` / `summarize` / `hidden` / etc. into `TsNode`s.
- The IR `TsRunnerThread`'s optional fields (`label`, `summarize`, `continueExpr`, `sessionExpr`, `hidden`) — they become regular function-call arguments handled by the existing call pipeline.
- The codegen-time mutual-exclusion check between `continue` / `session`, and the codegen-time rejection of `subthread(continue/session)` — both become **type errors** on the `ThreadOpts` / `SubthreadOpts` types (e.g. discriminated unions or distinct opts types per construct).

---

## Migration

Three focused PRs:

1. **Ship `__internal_thread`** in stdlib alongside the current parser-level form. Parser still emits the existing AST node; nothing user-visible changes. This proves the runtime + block-arg plumbing works.
2. **Flip the parser** to emit a function-call AST node calling `__internal_thread`. Keep the old `MessageThread` AST node as an alias for one release so any external tooling that introspects the AST has a deprecation window.
3. **Delete** the old AST node fields, parser branch, IR fields, codegen branch, and pretty-printer branch.

Each step is independently testable and revertable.

---

## Tradeoffs

**Pros**

- Future named args are **zero-code-change** in the parser/codegen — just add a field to the `ThreadOpts` type in `stdlib/threads.agency`.
- Errors become idiomatic type-system errors handled by the existing type checker.
- Removes ~200 lines across 5 files.
- Documentation can describe `thread {}` as "sugar for `__internal_thread(opts, block)`" with a one-page redirect to the function reference.

**Cons**

- Existing parse error messages ("Unknown thread argument: foo. Allowed: label, summarize, ...") become slightly less direct (the type-checker will say something like "Type `{foo: string}` is not assignable to type `ThreadOpts`"). Solvable with a custom type-checker rule if it matters.
- Any tooling that introspects the AST for `messageThread` nodes (doc generators, the AST dump) needs to update. Likely small surface area.
- Requires resolving the open question of how the `thread {}` block scope (lexical scope = caller's scope) maps to a block-arg function parameter. Per the existing [block-arg semantics](https://agency-lang.com/guide/blocks.html), this should already match how block-arg calls work — but worth confirming in step 1.

---

## Effort estimate

Roughly **3–4 developer-days** end-to-end including tests and fixture regeneration. Sliceable into the three PRs above (parallel codepath → flip → delete) so no single PR is large.

---

## Out of scope for this spec

- The per-feature work to add new named args (those become trivial once the refactor lands).
- Any user-facing language changes; this is a pure refactor of the implementation strategy. The surface syntax of `thread {}` and `subthread {}` does not change.

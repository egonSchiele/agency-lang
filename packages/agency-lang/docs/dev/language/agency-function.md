# `AgencyFunction`

> **User docs.** TS authors writing helpers called from Agency code don't need to wrap their functions — see [docs/site/guide/ts-helpers.md](../../site/guide/ts-helpers.md). `AgencyFunction` is what codegen emits around every Agency `def`; this page is for codegen and runtime maintainers.

## What it is

`AgencyFunction` (defined in [lib/runtime/agencyFunction.ts](../../../lib/runtime/agencyFunction.ts)) is a wrapper around a plain JS implementation function that adds the metaprogramming Agency `def`s rely on:

- **Named-argument resolution** — `def foo(a: number, b: string)` can be called positionally, named (`{a: 1, b: "x"}`), or with a mix. `AgencyFunction.invoke` reconciles call sites with the formal parameter list.
- **Block arguments** — Agency `def f(label: string, block: () -> any)` can be called as `f(label: "x") as { ... }`. The named descriptor carries the trailing block in its own `blockArg` field, and `resolveArgs` binds it by name to the last non-variadic parameter.
- **UNSET defaults** — Optional parameters use a sentinel (`UNSET`) so the body can distinguish "explicitly passed `undefined`" from "not passed at all", which matters for the `defaults` and `partial` semantics.
- **Variadics** — `def f(...items: number[])` resolves trailing positional args into an array.
- **Tool metadata** — `toolDefinition` is what `runPrompt` reads when dispatching LLM tool calls. It carries `{ name, description, schema }`, which `buildToolDefinition` in [lib/backends/typescriptBuilder.ts](../../../lib/backends/typescriptBuilder.ts) derives from the Agency signature and the docstring.
- **`.partial(args)`** — returns a new `AgencyFunction` with some args pre-bound. Used by codegen for Agency-level partial application.
- **`.preapprove()`** — returns a copy whose body runs under an auto-approve handler, pushed for the duration of every call via `withPushedHandler`. The handler approves `request_approval` interrupts, but passes on `std::guard` ones, because a bare approve on a guard trip grants no budget and the trip machinery treats that as a runtime error.
- **`.describe(text)`** — set or override the tool description shown to the LLM.
- **`.rename(name)`** — give a derived tool a distinct name. `.partial()` and `.describe()` keep the base name, so several tools derived from one function collide in a single `llm({ tools })` call unless you rename them.
- **Retry-safety markers** — `markers` carries the `destructive` and `idempotent` flags the tool loop and the MCP adapter read off a registered tool.

## What it is NOT

`AgencyFunction` does **not** participate in per-call runtime-context plumbing. `ctx`, `stack`, and `threads` flow through the active `agencyStore` ALS frame (see [async-context.md](../runtime/async-context.md)). The wrapper is purely about argument resolution and tool metadata.

The trailing `state` positional argument that `invoke` used to accept was removed in #207 (and the per-codegen `__state` parameter to `def`-generated functions was removed in #206). No call site or wrapped function should pass or receive a runtime-state object as a positional arg.

## When to wrap

| Code shape | Wrap? |
| --- | --- |
| Agency-source `def foo(...) { ... }` | yes — codegen does it for you |
| Plain TS function called from Agency as `foo(arg)` | no — reads context from ALS, returns its value directly |
| TS function you want to expose as an LLM tool | not supported — define a thin Agency `def` that delegates to your TS function and pass that `def` to `llm(...)` as a tool |
| TS function that needs `.partial()` / `.preapprove()` | not supported, those are codegen-only metaprogramming methods |

The "expose a TS function as a tool" gap is intentional. The tool registry is per-Agency-module and codegen-managed; exposing it directly to TS would require deciding how a TS-defined tool participates in registry composition, partial application, and preapprove semantics. All of those currently live on `AgencyFunction` instances synthesized by codegen. The Agency-`def` workaround composes cleanly with everything that already exists.

## Internals

The interesting code paths in [lib/runtime/agencyFunction.ts](../../../lib/runtime/agencyFunction.ts):

- `resolveArgs({type: "positional", args})` — straightforward positional resolution, filling UNSET for missing optional params.
- `resolveArgs({type: "named", positionalArgs, namedArgs, blockArg})` — reconciles the two. Positional fills first, named overrides, and missing slots get UNSET. It errors on duplicates or unknown names.
- `partial(args)` — returns a new `AgencyFunction` whose implementation pre-binds the supplied args before invoking the original.
- `preapprove()` — wraps the implementation function, not `invoke`, so the per-call hot path stays branch-free. The wrapper pushes the auto-approve handler on `ctx.handlers` through `withPushedHandler` in [asyncContext.ts](../../../lib/runtime/asyncContext.ts).

The `invoke({type, ...})` entry point is what every dispatch path (codegen `__call`, `__callMethod`, LLM tool dispatch in `runPrompt`) goes through. It is the single chokepoint where argument resolution lives. The body it ultimately runs is the original plain JS function, which sees positional args only. `invoke` also runs the call-depth guard (`withCallDepth`) and the failure-propagation check (`checkFailureArgs`), which uses each parameter's `acceptsResult` flag.

## See also

- [async-context.md](../runtime/async-context.md) — how `ctx`/`stack`/`threads` flow without going through `AgencyFunction`
- [docs/site/guide/ts-helpers.md](../../site/guide/ts-helpers.md) — user-facing TS surface (no `AgencyFunction` reference)
- [docs/site/guide/llm.md](../../site/guide/llm.md) — `tools:` option and tool dispatch from the user's perspective

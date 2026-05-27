# `AgencyFunction`

> **User docs.** TS authors writing helpers called from Agency code don't need to wrap their functions — see [docs/site/guide/ts-helpers.md](../site/guide/ts-helpers.md). `AgencyFunction` is what codegen emits around every Agency `def`; this page is for codegen and runtime maintainers.

## What it is

`AgencyFunction` (defined in [lib/runtime/agencyFunction.ts](../../lib/runtime/agencyFunction.ts)) is a wrapper around a plain JS implementation function that adds the metaprogramming Agency `def`s rely on:

- **Named-argument resolution** — `def foo(a: number, b: string)` can be called positionally, named (`{a: 1, b: "x"}`), or with a mix. `AgencyFunction.invoke` reconciles call sites with the formal parameter list.
- **Block arguments** — Agency `def f(body: block)` accepts a trailing block; `AgencyFunction` routes it into the named-arg slot codegen reserves.
- **UNSET defaults** — Optional parameters use a sentinel (`UNSET`) so the body can distinguish "explicitly passed `undefined`" from "not passed at all", which matters for the `defaults` and `partial` semantics.
- **Variadics** — `def f(items: ...number)` resolves trailing positional args into an array.
- **Tool metadata** — `toolDefinition` is what `runPrompt` reads when dispatching LLM tool calls. Carries `{ name, description, schema }` derived from the Agency-level signature and any `@describe` annotations.
- **`.partial(args)`** — returns a new `AgencyFunction` with some args pre-bound. Used by codegen for Agency-level partial application.
- **`.preapprove(handler)`** — pushes a handler that responds to interrupt-kinds the tool is known to raise. The handler is registered for the duration of the tool body via `withPushedHandler`.
- **`.describe(text)`** — set or override the tool description shown to the LLM.

## What it is NOT

`AgencyFunction` does **not** participate in per-call runtime-context plumbing. `ctx`, `stack`, and `threads` flow through the active `agencyStore` ALS frame (see [async-context.md](./async-context.md)); the wrapper is purely about argument resolution and tool metadata.

The trailing `state` positional argument that `invoke` used to accept was removed in #207 (and the per-codegen `__state` parameter to `def`-generated functions was removed in #206). No call site or wrapped function should pass or receive a runtime-state object as a positional arg.

## When to wrap

| Code shape | Wrap? |
| --- | --- |
| Agency-source `def foo(...) { ... }` | yes — codegen does it for you |
| Plain TS function called from Agency as `foo(arg)` | no — reads context from ALS, returns its value directly |
| TS function you want to expose as an LLM tool | not supported in v1 — define a thin Agency `def` that delegates to your TS function and pass that `def` to `llm(...)` as a tool |
| TS function that needs `.partial()` / `.preapprove()` | not supported in v1 — those are codegen-only metaprogramming methods |

The "expose a TS function as a tool" gap is intentional. The tool registry is per-Agency-module and codegen-managed; exposing it directly to TS would require deciding how a TS-defined tool participates in registry composition, partial application, and preapprove semantics — all of which currently live on `AgencyFunction` instances synthesized by codegen. The Agency-`def` workaround composes cleanly with everything that already exists.

## Internals

The interesting code paths in [lib/runtime/agencyFunction.ts](../../lib/runtime/agencyFunction.ts):

- `resolveArgs({type: "positional", args})` — straightforward positional resolution, filling UNSET for missing optional params.
- `resolveArgs({type: "named", positionalArgs, namedArgs})` — reconciles the two; positional fills first, named overrides, missing slots get UNSET. Errors on duplicates or unknown names.
- `partial(args)` — returns a new `AgencyFunction` whose implementation pre-binds the supplied args before invoking the original.
- `preapprove(handler)` — wraps `invoke` so the handler is pushed on `ctx.handlers` (via the encapsulated `withPushedHandler` in [asyncContext.ts](../../lib/runtime/asyncContext.ts)) for the duration of the body.

The `invoke({type, ...})` entry point is what every dispatch path (codegen `__call`, `__callMethod`, LLM tool dispatch in `runPrompt`) goes through. It is the single chokepoint where argument-resolution lives; the body it ultimately runs is the original plain JS function, which sees positional args only.

## See also

- [async-context.md](./async-context.md) — how `ctx`/`stack`/`threads` flow without going through `AgencyFunction`
- [docs/site/guide/ts-helpers.md](../site/guide/ts-helpers.md) — user-facing TS surface (no `AgencyFunction` reference)
- [docs/site/guide/llm.md](../site/guide/llm.md) — `tools:` option and tool dispatch from the user's perspective

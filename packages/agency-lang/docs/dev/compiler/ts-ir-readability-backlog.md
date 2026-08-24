# TS IR readability — running list

Observations and pain points spotted while refactoring `TypeScriptBuilder`. These are NOT actioned yet; this is a backlog to discuss later.

## Patterns that hurt readability

### 1. `ts.raw(...)` with embedded template strings

We frequently fall out of the IR to do something that the IR could express, e.g.

```ts
return ts.raw(`${baseStr}.splice(${startStr}, ${deleteCountStr}, ...${this.str(value)})`);
```

This loses type-safety, sourcemap potential, and pretty-printing control. Two failure modes:

- We `printTs` a node, splice it into a template string, then wrap the result in `ts.raw`. The node round-trips through a string for no reason.
- We pre-compute precedence/paren-wrapping manually (e.g. wrapping `await` in parens before applying `.foo`) instead of letting the printer handle it.

**Direction:** Audit `ts.raw(...)` call sites and promote each to a structured builder. Add new builders where they would replace a recurring raw-string pattern.

**Status:** still open. `lib/backends/typescriptBuilder.ts` has around 88 `ts.raw(...)` call sites.

### 2. Method-call chains require `$(...).prop().call().done()` ✅ (partially)

The fluent helper works, but readers always have to mentally translate `$(receiver).prop("foo").call(args).done()` into `receiver.foo(args)`. For very common shapes (`obj.method(args)`, `obj.prop`), a one-shot `ts.methodCall(obj, "foo", args)` reads better and is shorter.

**Direction:** Consider `ts.methodCall(receiver, name, args, opts?)` and `ts.awaitedCall(receiver, name, args)` for the chain emitters that always await.

**Done:** `ts.methodCall(receiver, name, args, { optional? })`, `ts.awaitCall(callee, args)`, and `ts.awaitMethodCall(receiver, name, args, opts?)` exist as of the high-frequency-builders PR. Most call sites in `lib/ir/builders.ts`, `lib/backends/typescriptBuilder.ts` and `lib/backends/typescriptBuilder/sectionAssembler.ts` migrated. About 33 fluent chains remain, all of them in `typescriptBuilder.ts`, mostly property reads and mixed-purpose chains that no one-shot builder covers.

### 3. Multiple ways to spell "an await of a call" ✅ (canonical form established)

We have `ts.await(ts.call(...))`, `$(...).done()` (with `.await()` modifier?), and inline `ts.raw("await ...")` in some places. Picking one canonical form would help.

**Done:** Canonical form is now `ts.awaitCall(callee, args)` and `ts.awaitMethodCall(receiver, name, args)`. All `ts.raw("await ...")` patterns in `typescriptBuilder.ts` and `sectionAssembler.ts` migrated.

### 4. Object literals with mixed regular and spread entries are verbose

```ts
ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
```

vs. what would be ideal:

```ts
ts.obj({ ...ts.runtime.state, data: varRef })
```

Today the array form is needed when spreading. `ts.obj` does accept a plain `Record<string, TsNode>`, but that shorthand cannot express a spread, so any object with one spread entry falls back to the array form. A helper that accepts a mix would round off this rough edge.

### 5. `printTs` reaching into the IR from outside the IR module

Code in `TypeScriptBuilder` calls `printTs(node, 1)` mid-build to splice the output into another string template. That breaks the IR abstraction, because once you stringify, you cannot re-traverse or transform. The finalize-body assembly in `lib/backends/typescriptBuilder/finalizeCodegen.ts` is the canonical example. `lib/backends/typescriptBuilder.ts` does the same for finalize bodies and for range comprehensions.

**Direction:** Provide an IR-level "wrap as async method member" or similar so we never pretty-print mid-build.

### 6. `TsNode` is a discriminated union with over fifty cases

When reading code that consumes `TsNode`, it is hard to remember the full set of `kind` values without opening `lib/ir/tsIR.ts`. The union is up to 53 members. A short summary comment at the top of `tsIR.ts`, or a generated docs page, would help. Some kinds also overlap (e.g. `runnerStep` / `runnerPipe` / `runnerBranchStep` all describe runner-step shapes — could share a discriminator?).

### 7. Scope/identifier helpers are split across `ts.id`, `ts.scopedVar`, `ts.self`, `ts.raw(name)`

All four still exist in `lib/ir/builders.ts`.

Picking the right one requires knowing what each compiles to. Worth documenting alongside each builder which compiled form they produce, and possibly consolidating.

### 8. Module-init plumbing is mostly `ts.raw` strings ✅

While extracting `assembleSections`, almost everything in the static-init / `__initializeGlobals` plumbing fell out as `ts.raw("await __initializeStatic(__ctx)")`, `ts.raw("let __staticInitPromise = null")`, etc. The IR has builders for assignments, function declarations, and calls, but for these helpers we still drop to strings because of:

- `await` as a leading keyword on a bare call: no `ts.await(call)` ergonomics that print as a statement.
- Hand-built `(async () => { ... })()` IIFE: no `ts.iife({ async: true, body })` builder.
- `let foo = null` initializer: ~~no `ts.letDecl(name, value)` form~~ — turned out `ts.letDecl(name, initializer?, typeAnnotation?)` already exists; the static-init plumbing just wasn't using it.

**Direction:** Add at least `ts.iife({ body, async })`, `ts.letDecl(name, value?)`, and double-check `ts.await` produces statement-form output.

**Done:** `ts.iife({ async?, params?, body })` added. The pretty-printer now wraps arrow/function-expression callees in parens automatically, so the IIFE shape `(async () => { ... })()` is purely IR-driven. `ts.awaitCall`/`ts.awaitMethodCall` cover statement-form awaits. The static-init plumbing in `sectionAssembler.ts` is now built from `ts.functionDecl`, `ts.iife`, `ts.letDecl` and `ts.assign`. Two `ts.raw` calls survive in that path: the `null` initializer for `__staticInitPromise`, and the `await __awaitStaticInit(...)` prelude lines.

### 9. Discriminator on assignment LHS in raw IR is asymmetric

The IR has both `ts.assign(lhs, rhs)` and `ts.globalSet(moduleId, name, value)`. For a reader, it is not obvious that the latter exists; we accidentally hand-wrote `ts.raw("__ctx.globals.set(...)")` in a couple of places before standardizing on `ts.globalSet`. `ts.assign` still carries no doc-comment, so a short one pointing readers at the global variant would help.

---

(Append more as we go.)

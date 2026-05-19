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

**Direction:** Audit `ts.raw(...)` call sites; promote each to a structured builder. Add new builders where they would replace a recurring raw-string pattern.

### 2. Method-call chains require `$(...).prop().call().done()`

The fluent helper works, but readers always have to mentally translate `$(receiver).prop("foo").call(args).done()` into `receiver.foo(args)`. For very common shapes (`obj.method(args)`, `obj.prop`), a one-shot `ts.methodCall(obj, "foo", args)` reads better and is shorter.

**Direction:** Consider `ts.methodCall(receiver, name, args, opts?)` and `ts.awaitedCall(receiver, name, args)` for the chain emitters that always await.

### 3. Multiple ways to spell "an await of a call"

We have `ts.await(ts.call(...))`, `$(...).done()` (with `.await()` modifier?), and inline `ts.raw("await ...")` in some places. Picking one canonical form would help.

### 4. Object literals with mixed regular and spread entries are verbose

```ts
ts.obj([ts.setSpread(ts.runtime.state), ts.set("data", varRef)])
```

vs. what would be ideal:

```ts
ts.obj({ ...ts.runtime.state, data: varRef })
```

Today the array-form is needed when spreading. A small helper that accepts a mix would round off this rough edge.

### 5. `printTs` reaching into the IR from outside the IR module

Code in `TypeScriptBuilder` calls `printTs(node, 2)` mid-build to splice the output into another string template. That breaks the IR abstraction — once you stringify, you cannot re-traverse or transform. See the class-method body assembly in `ClassEmitter.buildMethodCode` for the canonical example.

**Direction:** Provide an IR-level "wrap as async method member" or similar so we never pretty-print mid-build.

### 6. `TsNode` is a discriminated union with ~25 cases

When reading code that consumes `TsNode`, it is hard to remember the full set of `kind` values without opening `tsIR.ts`. A short summary comment at the top of `tsIR.ts`, or a generated docs page, would help. Some kinds also overlap (e.g. `runnerStep` / `runnerPipe` / `runnerBranchStep` all describe runner-step shapes — could share a discriminator?).

### 7. Scope/identifier helpers are split across `ts.id`, `ts.scopedVar`, `ts.self`, `ts.raw(name)`

Picking the right one requires knowing what each compiles to. Worth documenting alongside each builder which compiled form they produce, and possibly consolidating.

### 8. Module-init plumbing is mostly `ts.raw` strings

While extracting `assembleSections`, almost everything in the static-init / `__initializeGlobals` plumbing fell out as `ts.raw("await __initializeStatic(__ctx)")`, `ts.raw("let __staticInitPromise = null")`, etc. The IR has builders for assignments, function declarations, and calls, but for these helpers we still drop to strings because of:

- `await` as a leading keyword on a bare call: no `ts.await(call)` ergonomics that print as a statement.
- Hand-built `(async () => { ... })()` IIFE: no `ts.iife({ async: true, body })` builder.
- `let foo = null` initializer: `ts.letDecl(name)` exists but no `ts.letDecl(name, value)` form.

**Direction:** Add at least `ts.iife({ body, async })`, `ts.letDecl(name, value?)`, and double-check `ts.await` produces statement-form output.

### 9. Discriminator on assignment LHS in raw IR is asymmetric

The IR has both `ts.assign(lhs, rhs)` and `ts.globalSet(moduleId, name, value)`. For a reader, it is not obvious that the latter exists; we accidentally hand-wrote `ts.raw("__ctx.globals.set(...)")` in a couple of places before standardizing on `ts.globalSet`. A short doc-comment on `ts.assign` pointing readers at the global variant would help.

---

(Append more as we go.)

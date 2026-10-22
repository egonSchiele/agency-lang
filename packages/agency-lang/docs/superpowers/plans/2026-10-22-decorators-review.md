# Review: user-defined decorators plan (ADI-39, ADI-40)

Reviewed 2026-10-22 against `main` at `bf47fb34b`. Plan: `2026-10-22-decorators.md`. Spec: `docs/superpowers/specs/2026-10-22-decorators.md`.

## Verdict

The design is sound and the lowering is the right shape. The guard precedent holds up: `desugarGuardsInBody` mutates in place, runs twice, and the symbol table reads the raw tree and credits `_guard` as a callee exactly as the plan describes. Most of the file and line references check out.

Three things need to change before anyone starts Task 1. Each is a premise the plan builds on that the code does not support.

1. The type checker is off by default, so every diagnostic the plan adds is invisible to a default user. Decisions 3 and 6 rest on the checker.
2. `agency doc` does run the type checker, so it does lower, and Task 10 reads the wrong field.
3. Agency has no generics, so a decorator is tied to one block return type. The plan never decides how a reusable decorator is typed, and its own test list contradicts itself on this point.

The rest of this review is the detail on those three, then the smaller findings, then what I verified and found correct.

## Blocking

### 1. The diagnostics only exist when the type checker is on

`typechecker.enabled` defaults to `false` (`docs/dev/runtime/config.md:269`). This repo's `agency.json` turns it on, which is why it feels always-on when working here, but a user's project does not have that line. In `compileSource` the checker is skipped entirely when it is off (`lib/compiler/compile.ts:172`).

So with the plan as written, a default user who writes:

```
@budgted(cost: maxCost)
def researcher(task: string, maxCost: number): Result<string> { ... }
```

gets no "Unknown decorator" message. The preprocessor lowers the body into a call to `budgted`, and the program fails at runtime with whatever the runtime says about an undefined function, pointing at a line the user never wrote. The same user who puts `@budgeted` on a `node` gets silence: `collectTags` attaches the tag to the node and nothing reads it. That is the exact outcome decision 3 says it exists to prevent.

The fix is to put the two part 1 checks where they always run. `prepareProgram` is the one pipeline every caller shares (`docs/dev/compiler/prepare-program.md`), and the plan's own Background notes that resolver errors there carry AG codes. The desugar already has a `lookup`; when it returns nothing, the pass can return a diagnostic instead of lowering, and `prepareProgram` reports it the way it reports an unresolved import. The wrong-place check reads `tagsAbove` and needs nothing from the checker, so it belongs in the same place.

That changes decision 6 ("an unresolved decorator still lowers"). Keep the half-typed-tag goal, but note the checker is not the mechanism that delivers it for most users. If the maintainer wants to keep the checks checker-only, the plan should say plainly that a default user sees a runtime error for a typo in a decorator name, so the maintainer is choosing that knowingly.

### 2. `agency doc` lowers, because it type-checks

The plan says in Background and in Task 10: "`agency doc` calls `attachTags()` alone" and "never lowers". It does call `attachTags` (`lib/cli/doc.ts:369`), but `generateDocForFile` then calls `typeCheck(program, ctx.config, info)` at `doc.ts:414` to fill the Throws column. The checker's constructor is where the plan puts the decorator desugar, so by the time `generateFunctionSection` renders a function, the decorator tags have been moved off `def.tags` onto `def.decorators` and the body is the lowered `return budgeted(...) { }`.

Two consequences for Task 10 step 2:

- Read `fn.decorators`, not `fn.tags` filtered by `isDecoratorTag`. With the plan's field layout, the filtered list is empty by then.
- Check what the function section renders besides the signature. If it prints any part of the body, it will print the lowered form, which rule 4 of the spec forbids showing to users.

Also correct the Background paragraph so the next reader does not inherit the mistake. The effect side is fine: `buildCompilationUnit` and `SymbolTable.build` run before `typeCheck` in `doc.ts`, so the Throws column reads the raw tree, and Task 4's edge is what makes `std::guard` appear for a `@budgeted` function.

### 3. No generics: decide how a reusable decorator is typed

There is no type parameter support on a `def` (no `typeParameters` on `FunctionDefinition`, nothing in `lib/types/typeHints.ts`). A decorator's block parameter is therefore one concrete type:

```
def logged(block: () -> string): string { ... }
```

This decorator cannot go on a function returning `number`. The body's `return 5` is checked against the block slot's `string` (`checker.ts:880`, the "block return" branch) and refused. The plan's test list assumes it can:

- `log-around` defines `logged` with `block: () -> string`.
- `schema-unchanged` writes `@logged def tool(x: number): number`.
- `decorated-block-taker` writes `@logged def each(...): number[]`.

Those three cannot all pass with one `logged`. The motivating case has the same problem one level up: `@budgeted` is meant to replace boilerplate across every stdlib agent, and those agents do not all return `Result<string>`.

The plan needs a decision 7. The two options I see:

- **Type the block as `() -> any` and the decorator's return as `any`.** One `logged` works everywhere. The cost is that `getBlockSlot` returns nothing for an `any` block (`lib/typeChecker/utils.ts:40`), so the body's returns are not checked against anything, and the Task 8 diagnostic `decoratorBodyReturn` has almost nothing to fire on. The decorated function's declared return type still checks the lowered `return budgeted(...)` against `any`, which always passes, so a `@budgeted` function that forgets to return a `Result` is not caught either.
- **One decorator per return type**, written as `budgetedString`, `budgetedReport`, and so on. Everything type-checks, and the boilerplate comes back in a smaller form.

I would pick the first and say so in the guide, because the point of the feature is reuse, and the stdlib agents are already loosely typed at that boundary. But it is the maintainer's call, and the plan should not go to a worker with the question open. Whichever is chosen, fix the three tests so they agree.

## Significant

### 4. The spec's `budgeted` example does not type-check as written

```
def budgeted(call: Call, cost: number, time: number, block: () -> string): Result<string> {
  return guard(cost: cost, time: time, label: call.name) {
    return block()
  }
}
```

The block is `() -> string`, so the decorated body may only return strings. A `Result<string>` function that writes `return failure("no results")` anywhere in its body will be refused at the block return check. That is most of the stdlib agents. Either the block type is `() -> Result<string>` and the guard's own wrapping has to be thought through (what does `guard` do with a block that already returns a `Result`?), or the example only covers bodies that never fail on their own. Run this example through `pnpm run ast` and a type-check before it lands in the guide page in Task 11. This ties into finding 3: with an `any` block the problem disappears at the cost of the check.

### 5. Decision 2 drops the guard's yield stamp inside every decorated body

Decision 2 is correct about why decorators lower first. The side effect it does not mention: a return-position `guard { }` inside a decorated body now sits inside a block argument, so the guard desugar's `returnTarget` resets (`guardDesugar.ts`, the `DesugarContext` comment) and the guard gets no `Result<T>` stamp. Today, writing `return guard { ... }` in a `Result<string>` function gives the guard its success type from the declaration. Add `@budgeted` above that function and the stamp is gone.

Whether that is visible depends on finding 3. With a typed block slot (`() -> Result<string>`), the desugar could take the stamp from the slot's return type instead of from the def, which is a small addition to the walk context. With an `any` block, nothing checks the guard's yield anyway. Either way, add a test `guard-in-decorated-body` to Task 6 so the behaviour is pinned rather than discovered.

### 6. A decorator's handler is not credited by the effect walk

The `handler-in-decorator` test is good and should stay. One thing the dev doc should say: the symbol table's walk will report the body's `std::env` as an effect of the decorated function even when the decorator wraps `block()` in `handle { } with approve`, because the walk sees the decorator as a callee and the body as a body, and cannot see that one answers the other. This is the same today for any block-taking function that installs a handler, so it is not a regression. But a reader of `agency doc`'s Throws column or of `agency policy gen` output for a `@approving` function will see an effect listed that is in practice always answered, and the dev doc is where they should learn why. Over-reporting is the safe direction here, as the effect-propagation doc's invariant says.

### 7. The tag argument type is narrower than the parser it adopts

Task 1 widens `Tag.arguments` to `(Expression | NamedArgument)[]`, but `argumentListParser` yields `(Expression | SplatExpression | NamedArgument)[]` (`lib/types/function.ts:111`). Either widen the tag type to match, or wrap the list parser to refuse a splat with a message. `@retry(...opts)` has no sensible meaning and refusing it is simpler than threading splats through `formatTag` and the desugar.

### 8. A decorator can decorate itself

`@retry(3) def retry(times: number, block: () -> Result): Result` lowers to a body that calls `retry`, which calls `retry`, forever. Nothing in the plan refuses it. A one-line check in the desugar or in the Task 5 pass (the decorator name equals the def name) with a test is enough. The effect walk's worklist already handles the cycle, so this is only a runtime hazard.

### 9. `schema-unchanged` has no helper to lean on

There is no `toolSchema` or similar export in `stdlib/agency.agency`. The plan hedges ("or, if none is exported"), but a worker will spend time looking. Replace the test with one that already has a home: the `tests/typescriptGenerator/decorators.agency` fixture in Task 7 pins the generated tool metadata next to the lowered body, and the `tests/agency-js/decorator-handoff` scripted-model test can assert on the tool definitions the mock provider received. Between them the "nothing reaches the model" property is pinned without a new stdlib function.

### 10. Mixed tags on one def must keep their order

A def can carry `@validate(...)` and `@budgeted(...)` together. The desugar drops decorator tags from `def.tags` and leaves the reserved ones. `mergeTags.ts` and `validationDescriptor.ts` filter by name so they do not care about position, but `agency doc` prints `def.tags` in order. Add a unit test in `decoratorDesugar.test.ts` with a reserved tag above, between, and below two decorators, asserting the reserved tags survive in their original relative order and the decorators nest outermost-first.

## Small corrections

- Background: `collectTags` is at `typescriptPreprocessor.ts:169`; line 107 is `attachTags`, the function it wraps.
- Task 10: `generateFunctionSection` is at `doc.ts:713`, not 724.
- Background: `_bodyNodeParser` is at `parsers.ts:5989`. `guardBlockParser` is defined at 6438, not 6441. Close enough, but a worker grepping an exact line will stumble.
- Task 2: `type Call = { name: string, args: object }`. The parser accepts `object` as a primitive type name (checked with `pnpm run ast`), so this is fine. Say in the doc comment that `args` is an open record so a reader does not go looking for a stricter type.
- Task 5: "take the next free codes in the AG6xxx range". The last code in `diagnostics.ts` is AG6040. Say "AG6041 and AG6042" so two workers on PR 1 and PR 2 do not collide.
- Review Focus mentions `tests/agency/decorators/schema-unchanged` by name; update it if finding 9 is taken.
- The plan's header says the spec is "the Linear project description". The spec now also lives at `docs/superpowers/specs/2026-10-22-decorators.md`; point at the file so the two cannot drift.

## What I verified and found correct

- `desugarGuardsInBody` runs in the `TypeChecker` constructor (`lib/typeChecker/index.ts:113`) and again in `preprocess()` (`typescriptPreprocessor.ts:345`), mutates in place, and is idempotent, for the reason its header gives. The checker's `functionDefs` is a shallow copy of the record over the same def objects, so an in-place body rewrite is visible to it.
- `compileSource` type-checks and then preprocesses the same `liftedProgram` (`compile.ts:174`).
- `collectBodyFacts` counts a `guardBlock` as a call to `_guard` (`bodyFacts.ts:116`), and `summariesForFile` builds `calleeKeys` from `view.readBody(declaration.body).callees` (`effects.ts:224`). Adding decorator names there, resolved through the same `makeResolver`, is the right place and covers imports.
- `getParamsForNodeOrFunc` looks up `functionDefs`, then `nodeDefs`, then `importedFunctions` (`utils.ts:20`). `getBlockSlot` and `checkNamedArgStructure` (`checker.ts:554`) exist as described.
- `restrictedTagArgParser` (`parsers.ts:2957`) and `argumentListParser` (`parsers.ts:3178`) are where the plan says, and `_tagParserInner` captures the name before the argument list, so branching on the name is straightforward.
- `tagsAbove` is read-only and recurses through `bodySlots`, and `attachTags` attaches to `graphNode`, `function`, `assignment`, `functionCall`, `typeAlias`, and `effectDeclaration`, matching the list in Task 5's `decoratorTarget`.
- `finalizeChecks.ts:106` stops scanning at a `blockArgument`, so a `finalize` at the top of a decorated body is legal.
- The cited fixtures all exist: `tests/agency/blocks/block-inline-interrupt.test.json` (with `interruptHandlers`), `tests/agency/guards/finalize-in-guard-block.agency`, `tests/agency/destructive-block.agency`, `tests/agency/match-expr-in-block.agency`, `tests/agency-js/handoff/`.
- `docs/dev/compiler/effect-propagation.md` has the "Which tree each side sees" table (line 198). `docs/dev/compiler/typechecker/README.md` has "Adding a new diagnostic" (line 380). The sidebar's Blocks entry is at `config.mts:73`. `make doc` exists.
- PR #1252 is merged and PR #1253 (AG6025, the valid-names sentence) is open, as the plan says.
- The `handoff` concern is correctly left as a stop-and-report. `applyEndTurnDecision` writes onto the frame's `toolInvocationStack`, and whether a lifted block shares that frame is exactly what the `decorator-handoff` test will tell us.
- `partial` exists (`tests/agency/partial-application-*.agency`), so the `call-record` test's `f.partial(a: 2)()` is valid.

## Suggested order of edits to the plan

1. Add decision 7 (how a reusable decorator is typed) and fix the three tests that disagree.
2. Move the unknown-decorator and wrong-place checks into `prepareProgram`, or state the checker-only trade-off in the plan.
3. Correct the `agency doc` paragraph and Task 10 step 2.
4. Fix the spec example or mark it as pending finding 3.
5. Add the `guard-in-decorated-body`, self-decoration, and mixed-tag tests.
6. Apply the small corrections.

## Anti-pattern check (added after the first pass)

Checked against `docs/dev/contributing/anti-patterns.md`, with the question "does the plan write declarative interfaces that encapsulate imperative complexity?" in mind.

**Partly.** The design does: a decorator is a pure rewrite from one tree shape to another, and the plan rightly keeps the runtime out of it. Where the plan slipped was in how it described the code, and a worker following it literally would have written the anti-pattern.

- **Imperative code everywhere.** Task 2 was a numbered list of mutations ("set `def.decorators`, drop from `def.tags`, remove the nodes, build the chain, assign `def.body`"). That is the "how" with no "what". The plan now names a pure `loweredBody(def, tags, lookup)` that returns the new body, and one `desugarDecorators` that does the writes. Task 8 (PR 2) had each of three checker sites grow its own `if (call.decorator)`; it now routes through one `blameFor(call)` helper.
- **Duplicating existing code.** The two callers each built their own `lookup` lambda; there is now one `decoratorLookup(functionDefinitions, importedFunctions)`. `decoratorsAbove` is built on `tagsAbove`, not a second walk.
- **Order-dependent mutable state.** Task 3 adds a real ordering constraint to `preprocess()` (`getFunctionDefinitions()` before the desugar). It is inherent to that method, which is a sequence of in-place passes. The mitigation is that the desugar takes its inputs as arguments rather than reading `this.functionDefinitions` lazily, and the comment names the dependency.
- **Nested objects in type definitions.** `FunctionCall.decorator?: { name, tagLoc, target }` is now the named type `DecoratorOrigin`.
- **Inconsistent patterns.** The new pipeline stage mirrors `LiftFailure`; the desugar mirrors `guardDesugar`; the effect edge mirrors how `_guard` is credited. The plan says so in its "Shape of the code" section.
- **Useless special cases.** None found. The one tempting special case, "if no decorators, return the body unchanged", falls out of mapping over an empty list.
- **Try-catch without logging, one-line ifs, magic numbers, single-letter names, nested ternaries.** Nothing in the plan requires any of these; the `what` phrase table in `decoratorProblems` avoids the if-chain that would otherwise have produced a nested ternary.

The plan file now carries a "Shape of the code" section with these rules, so a worker does not have to rediscover them from the catalog.

# User-defined decorators

A decorator is an ordinary `def` whose last two parameters are `call: Call` and a block, with its own parameters in front of them. Writing `@name(args)` above a function means "run my body as the block passed to `name`". Nothing else about the function changes: its name, docstring, parameters, tool schema, and `handoff`, `destructive`, and `idempotent` markers all stay on the `def`. The model never sees a decorator.

```
def logged(call: Call, block: (args: object) -> any): any {
  print("entering ${call.name}")
  const result = block(call.args)
  print("leaving ${call.name}")
  return result
}

@logged
def greet(name: string): string {
  return "hello ${name}"
}
```

Specs: `docs/superpowers/specs/2026-10-22-decorators.md` (the feature) and `docs/superpowers/specs/2026-10-23-decorator-shape-and-arguments.md` (the fixed shape, `block(record)`, and the `@guarded` rename). Plan and review: `docs/superpowers/plans/2026-10-22-decorators.md` and `2026-10-22-decorators-review.md`. Tickets ADI-39 (the lowering) and ADI-40 (diagnostics, `agency interrupts`, `agency doc`, and the guide page `docs/site/guide/decorators.md`).

## What the compiler does

The tag lowers to a call with the body as the block argument. The tag's own arguments come first, as written; the `call` record is passed by name after them; the block takes one parameter, `__args`, and starts with a `rebindParameters` statement. `greet` above becomes:

```
def greet(name: string): string {
  return logged(call: { name: "greet", args: { name: name } }) {
    <rebindParameters>
    return "hello ${name}"
  }
}
```

The lowering lives in `lib/preprocessors/decoratorDesugar.ts`, next to `guardDesugar.ts`, which it copies in every structural respect:

- **It mutates in place.** The compilation unit built before the TypeChecker constructor already holds the def objects, so a copying rewrite would leave it pointing at undecorated bodies. The innermost block reuses the def's own body array.
- **It is idempotent.** The tags move from `def.tags` and the top-level list onto `def.decorators`. A second run finds nothing to lower. `compileSource` type-checks and then preprocesses the same program object, so the pass runs twice on it.
- **It runs in two places.** The `TypeChecker` constructor (`lib/typeChecker/index.ts`) and `TypescriptPreprocessor.preprocess()`. Either may be the first to see a program: the checker is off by default, and unit tests call each directly.
- **It runs before the guard desugar.** A return-position `guard { }` is stamped with the def's `Result<T>` success type. Inside a decorator's block a `return` yields to the decorator, not the def, so the stamp would be wrong. Lowering decorators first means the guard desugar meets the body inside a block argument and stamps nothing, as for any other block. `tests/agency/decorators/guard-in-decorated-body.agency` pins that the guard still works.

The module has three pure functions and one that writes:

- `decoratorsAbove(nodes)` pairs each top-level def with the decorator tags above it, outermost first. It is built on `tagsAbove` and reads both standalone tags and ones `collectTags` already attached.
- `loweredBody(def, tags, lookup)` returns the new body. It never touches the def.
- `decoratorProblems(program, scope)` returns everything wrong with the program's decorators (below).
- `desugarDecorators(program, lookup)` assigns `def.body`, `def.decorators`, `def.tags`, and filters the tag nodes out of `program.nodes`.

The `lookup` both callers pass comes from `decoratorLookup(functionDefinitions, importedFunctions)`, so the two cannot drift. It answers two questions: does the decorator's first parameter have the name `call`, and is the decorator imported (the call then carries `scope: "imported"`, as `_guard`'s does).

## The rules

1. **The shape.** A decorator's second-to-last parameter is named `call` and its last takes a block (`lastParameterTakesBlock`: block-typed, untyped, or `any`); neither has a default. `hasDecoratorShape`, `decoratorShapeProblem`, and `callerSuppliedParameters` in `lib/types/function.ts` are the one place that knows this, and the parser's ordering check, AG6039, the lowering's checks, and the checker's argument counts all go through them. A def of any other shape named in a tag is a compile error that says which slot is wrong.

   Two other layouts were weighed and set aside: `call` first would put tag arguments one slot off from the parameter list; `call` and the block first would break the rule that a block binds to the last parameter. An optional `call` recognized by position was set aside too: a parameter in the wrong slot then silently changed how the decorator was called.

   **The `call` record** is `{ name, args }`: the decorated function's name and its parameters by name, block-typed parameters left out (a block cannot be stored in a record). It is passed by name, `call: __call_N`, after the tag's own arguments, so it never competes with a positional tag argument for a slot. It is built in its own `const` statement right before the call, from the parameters as they are at that moment. That statement is its own step: a resume replays the step that calls the decorator, and building the record there would read parameters the decorator has since rebound. The const's local is restored from the checkpoint instead (`tests/agency/decorators/rebind-call-args-after-resume.agency`). `type Call` is in the prelude (`stdlib/index.agency`, listed in `PRELUDE_NAMES`).

   **The block takes the arguments.** The decorator chooses what the body runs with: `block(call.args)` runs it with the arguments as passed, `block({ ...call.args, name: "x" })` with one changed, `block()` with none (defaults apply; a parameter with no default is a missing argument). The block's first statement is the synthetic `rebindParameters` node (`lib/types/rebindParameters.ts`), which compiles to one `__rebindParameters` call (`lib/runtime/rebind.ts`) over a table of the function's parameters, each default a thunk compiled where the function's scope is visible. The runtime binds the record with `AgencyFunction.bindRecord`, a public method over the private `resolveNamed`, so unknown keys, missing arguments, variadics, and aliases follow the rules of a call and produce its messages; it stores the values on the enclosing function's frame (`__stack.args`, reached lexically from the block); then it runs the `!` checks over the rebound parameters, so a decorator cannot route a value around a validator. Any failure halts the block's runner, so `block()` returns a failure value and nothing propagates through the decorator.

   **A rebind survives a pause.** A function stores every parameter on its frame on every entry, and a resume re-enters it with the caller's original arguments, which would overwrite the rebound slots. A decorated def therefore stores its parameters on first entry only (`firstEntryParamStore`, the store a `!` parameter already used), so a restored frame keeps what the rebind wrote, and the rebind step itself is skipped on resume like any completed step. `tests/agency/decorators/rebind-resumes.agency` pins this with a real pause.

   **One rebind at a time.** The rebound values live on the function's frame, which every call to `block` from the same decorator shares. A decorator that calls `block` from concurrent branches (`fork`, `parallel`) with different records gets crossed arguments: each branch's body reads whichever rebind ran last. Call `block` from one branch at a time, or give each variant its own decorated function. Per-branch parameter frames would be the fix, and are not built.

   **Block-typed parameters are kept, not rebound.** A record cannot carry a block, so the function's block-typed parameters are left out of `call.args` and the rebind table, and the rebind passes their current values to `bindRecord` by name, wherever they sit in the parameter list. A record that names one is refused: "'body' is a block parameter of 'f' and cannot be rebound".

   **Stacking rebinds in turn.** `@outer @inner def f` lowers to `outer(call: …) { rebind; return inner(call: …) { rebind; body } }`. `inner`'s record is built after `outer`'s rebind ran, so `inner`, and the tag arguments written on it, see the arguments `outer` passed.

   Because `Call` is a prelude name, a file's own `type Call`, or a `Call` it imports from another file, must win over it. `prunePreludeShadows` drops a prelude name a type or an import shadows, as it already did for a def, a node, or a global; without that, the prelude's `Call` and the file's are two bindings of one name and the module fails to load (`tests/agency/decorators/local-call-type.agency`).
2. **The tag's arguments are evaluated on every call**, in the decorated function's scope, so they can name its parameters.
3. **Stacking is nesting.** `@a @b def f` becomes `a(...) { return b(...) { body } }`.
4. **Resolution is by name**, like a call, imports included. The reserved tag names (`RESERVED_TAG_NAMES` in `lib/types/tag.ts`: `capabilities`, `validate`, `jsonSchema`, `hidden`, `always`, `alwaysUnder`, `optimize`) are never decorators.
5. **The formatter prints the tag back**, never the lowered body. `agency fmt` parses and prints without lowering; `formatTag` renders a tag's arguments through the same `renderArgList` a call uses, so named arguments and comments survive.
6. **The block rules apply.** A decorator calls `block()` directly and may call it more than once (`tests/agency/decorators/retry-calls-block-twice.agency`). It never stores or returns the block.
7. **`def` only.** A decorator tag on a node, a type, a statement, or nothing is a compile error.

## How the tag grammar changed

Before this, every tag took the static argument grammar: literals, identifiers, partial applications, no calls, no named arguments. Now the parser reads the tag's name first (`_tagParserInner` in `lib/parsers/parsers.ts`) and picks the argument grammar by it. A reserved name keeps the static grammar; any other name takes `argumentListParser`, the list a call takes. Splats and inline blocks are refused on a tag, since a decorator's block is the decorated body.

`Tag.arguments` is therefore `(Expression | NamedArgument)[]`. Every reader of a reserved tag goes through `positionalTagArguments(tag)` and never sees a named argument.

## Where mistakes are reported

The type checker is off by default (`typechecker.enabled`, `docs/dev/runtime/config.md`), so a diagnostic only it emits is invisible to most users. `decoratorProblems` lists every mistake below, and two places turn the list into errors:

- `prepareProgram` (`lib/compiler/prepareProgram.ts`) reports it as a `"decorators"` pipeline stage beside `"lift"`. Its callers are `compileSource`, `agency typecheck`, the LSP, and `agency interrupts`.
- The CLI build (`lib/compiler/buildSession.ts`, behind `agency run` and `agency compile`) does not go through `prepareProgram`, so `checkDecoratorsOrExit` runs the same check right after the compilation unit is built and stops the build. The first version of this feature missed this path: a typo in a decorator name compiled and failed at runtime, and a decorator on a node was dropped without a word. `tests/agency/decorators/compile-errors/` pins each mistake through `agency compile` with the checker off.

The mistakes:

- an unknown decorator: "Unknown decorator 'budgted' on 'f'. A decorator is a def whose last parameter is a block; declare or import 'budgted'."
- a decorator in the wrong place: "'@logged' is written on node 'main', but a decorator goes on a def."
- a decorator with nowhere to put the body: "'tagged' cannot decorate 'greet': a decorator receives the body of the function it decorates as a block, so its last parameter must be a block". Compiled anyway, `greet` would return `tagged`'s value and never run its own body. The test for "can take a block" is `lastParameterTakesBlock` in `lib/types/function.ts`, which the checker's AG6015 also uses: a block-typed, untyped, or `any` last parameter.
- a decorator imported from JavaScript: "'wrap' is imported from JavaScript, so it cannot decorate 'greet'." A JavaScript function cannot take a block, so this would fail on every call.
- a def that decorates itself, or defs that decorate each other: "Decorators call each other in a loop: a → b → a." Either would recurse until the call-depth limit. Only the file's own defs are followed; a loop that runs through another file still ends at the runtime's limit.

`decoratorProblems` reads tags wherever they are at the moment (standalone, attached, or already lowered), so it works before or after the lowering. The LSP gives the stage a range from the tag's location; `failIfNotCheckable` in `lib/compiler/typecheck.ts` treats the stage like a lift failure. The editor and `agency typecheck` keep going past the failure and run the checker, which skips the undefined-function warning on a call that carries `decorator` (`undefinedFunctionDiagnostic.ts`), so an unknown decorator is reported once. `describeDiagnostic` prints the failure's line, as a type error does.

Type mismatches are reported by the checker through the ordinary call and return checks, and named for the decorator through `call.decorator`. See "Diagnostics and doc output" below.

## How effects reach a decorated function

The symbol table's effect walk (`lib/analysis/effects.ts`) runs over raw parse trees, before any lowering, and builds call edges from bodies. A decorated body never calls its decorator, so `summariesForFile` adds each decorator tag above a def as a callee of that def (`decoratorNamesByDef`). This is the same arrangement as `_guard` in `bodyFacts.ts`. All three views share it, so a function under the stdlib `@guard` carries `std::guard` in `agency doc`, in `agency policy gen`, in the static-init safety check, and in its host capabilities, and a `raises` clause that omits it is AG3030, the decorator form of AG3013 (`lib/typeChecker/raisesDiagnostic.test.ts`). The type checker sees the lowered tree and finds the same edge on its own; `lib/analysis/effectsOracle.test.ts` compares the two.

The walk cannot credit a handler the decorator installs around `block()`. For

```
def approving(block: () -> any): any {
  let result = null
  handle { result = block() } with approve
  return result
}
```

the body's effects are still reported on the decorated function, though the decorator always answers them. This is the same for any block-taking function that installs a handler, and it is over-reporting, the safe direction.

## Why a reusable decorator types its block as `any`

There are no generics on a `def`. A decorator written as `block: () -> string` is refused on a function returning `number`, because the checker checks the body's returns against the block slot. A decorator meant for one return type (`@budgeted` over `Result<string>`) can type its block precisely and gets that check. A decorator meant for every function (`@logged`, `@retry`) writes `block: () -> any): any`, and the body's returns are then unchecked, as for any `any` block today. Nothing in the language changes for this; it is a trade-off the guide states.

One consequence worth knowing: a `Result<T>` function returns a success by writing `success(value)`. Inside an `any`-typed decorator a bare `return value` stays bare, so a caller's `.value` reads nothing. `retry-calls-block-twice` shows the right shape.

## Why interrupts needed nothing

The body is a block argument, and blocks already resume through step counters, already carry handlers on the chain, and already run more than once under `revise`. `tests/agency/decorators/interrupt-resumes`, `retry-calls-block-twice`, and `handler-in-decorator` pin each of these. `handler-in-decorator` also pins that a decorator's `approve` does not outrank its caller: a caller that rejects still gets a rejection, because every handler on the chain is consulted. This matters because a decorator from a package can install a handler that is invisible where the def is written. The runtime did not change.

## A gap this work found, since fixed

Part 1 found that a `destructive { }` region inside a block argument lost its `destructiveRan` mark when the block exited, so a failure escaping a decorated function read `false` and the tool loop's removal of a destructive tool failed open. ADI-56 fixed it in the tracking codegen: the flag is written through `__activation`, which a block reaches lexically. `tests/agency/decorators/destructive-region-in-body.agency` pins the decorator case; `docs/dev/language/destructive-regions.md` has the design.

## The stdlib decorator: `@guarded`

`std::strategy` ships one decorator, `@guarded(cost:, time:, label:)`, which every budgeted stdlib agent carries. What it does with a budget trip, and how a draft the body saved reaches its guard, is in `docs/dev/agents/subagent-budgets.md`. Its name differs from the `guard { }` block's on purpose: `guard(...) {` always parses as the block, so a decorator named `guard` could not be called as a function. The agents that post-process their guarded result still keep the guarded part in an inner def, because a decorator wraps a whole def and the post-processing wants to sit outside the wrap.

## Files

- `lib/types/tag.ts`: `RESERVED_TAG_NAMES`, `isDecoratorTag`, `positionalTagArguments`, the widened `Tag.arguments`.
- `lib/parsers/parsers.ts`: `_tagParserInner`, `reservedTagArguments`, `decoratorTagArguments`.
- `lib/preprocessors/decoratorDesugar.ts` and its test.
- `lib/types/function.ts`: `FunctionDefinition.decorators`, `DecoratorOrigin`, `FunctionCall.decorator`, and the shape: `hasDecoratorShape`, `decoratorShapeProblem`, `callerSuppliedParameters`.
- `lib/types/rebindParameters.ts`: the synthetic statement; `lib/runtime/rebind.ts`: `__rebindParameters`; `lib/runtime/agencyFunction.ts`: `bindRecord`.
- `lib/backends/typescriptBuilder.ts`: `processRebindParameters` (the function is reached through `__toolRegistry` by its module key, which a parameter named like the function cannot shadow), `firstEntryParamStore`, the `storeOnFirstEntry` option of `buildFunctionBody`.
- `lib/parsers/parsers.ts` and `lib/typeChecker/paramDefaultOrder.ts`: the ordering check over `callerSuppliedParameters`.
- `lib/typeChecker/index.ts`, `lib/preprocessors/typescriptPreprocessor.ts`: the two call sites.
- `lib/compiler/prepareProgram.ts`: `DecoratorFailure` and the check; `lib/lsp/diagnostics.ts`, `lib/compiler/typecheck.ts`.
- `lib/compiler/buildSession.ts`: `checkDecoratorsOrExit`, the same check for `agency run` and `agency compile`.
- `lib/preprocessors/prunePreludeShadows.ts`: a local type or an import shadows a prelude name such as `Call`.
- `lib/analysis/effects.ts`: `decoratorNamesByDef`.
- `lib/backends/agencyGenerator.ts`: `formatTag`, `decoratorLines`.
- `lib/typeChecker/mismatch.ts`: which entry a mismatch becomes; `lib/typeChecker/decoratorChecks.test.ts` pins each message.
- `lib/typeChecker/raisesDiagnostic.ts`: `decoratorCarrying`.
- `lib/typeChecker/interruptAnalysis.ts` and `lib/analysis/interrupts.ts`: `viaBlockOf`, `blockCallHandlers`, `withBlockCallHandlers`.
- `stdlib/index.agency` and `lib/prelude.ts`: `type Call`.
- Tests: `tests/agency/decorators/` (with `compile-errors/` for the checks through the CLI), `tests/agency-js/decorator-handoff/`, `tests/typescriptGenerator/decorators.agency`.

## Diagnostics and doc output

This is ADI-40. None of it changes generated code.

### Mismatches name the decorator

The lowering gives the synthesized call and the `return` around it the tag's `loc`, so errors on them already land on the tag's line. What changes is the wording. `lib/typeChecker/mismatch.ts` holds a table with one row per site, and each site asks it which entry to push:

| Site | Plain entry | Decorator entry |
|---|---|---|
| argument (`checkArgsAgainstParams`) | AG6019 `argNotAssignable` | AG6041 `decoratorArgType` |
| block return (`checkExpressionsInScope`) | AG2001 `typeNotAssignableInContext` | AG2018 `decoratorBodyReturn`, or AG2019 `decoratorStackedReturn` |
| declared return (`checkReturnTypesInScope`) | AG2001 `typeNotAssignableInContext` | AG2020 `decoratorReturnMismatch` |
| draft (`checkSaveDraftCall`) | AG2001 `typeNotAssignableInContext` | AG2021 `decoratorDraftType` |

The decorator entry is used when the owning call carries `decorator`. The stacked entry covers `@a @b def f`: `return b(...)` sits in `a`'s block, so a block return whose value is itself a decorator's call is the two decorators disagreeing, and the message names both.

The return sites still go through `checkType`. `checkType` and `emitAssignabilityError` take the entry to push as their last argument, so `rejectRegexInLlmType`, `reportFailureDataError` (`failureNeedsData`), and `checkExcessObjectProperties` run as before. Both return sites now pass the `return` statement's `loc` as the fallback, so a mismatch on a literal, which has no position of its own, gets a line. That fixed plain block returns too.

A plain block-taking function's block body was already checked against its block type; `decoratorChecks.test.ts` pins it.

### Drafts in a decorated body

A `saveDraft(value)` is the value of the frame it is saved in. A decorated body is the decorator's block, so its draft must fit the block slot's return type (`any` when the slot is untyped), not the def's declared type: in a `Result<string>` def under a decorator whose block returns `string`, `saveDraft("partial")` is right and `saveDraft(42)` is AG2021. `draftTarget` in `mismatch.ts` picks the type from the innermost block around the draft. A draft in an ordinary call's block, such as a `guard` block, is still checked against the scope's return type, as before; block bodies share their enclosing scope in the checker, and changing that for every block is a separate decision.

### Counts on a tag

The lowering adds the `call` record and the body. `checkArity` subtracts both (`params.length - callerSuppliedParameters(params).length`) before printing a count, so `@budgeted` with no arguments says "Expected 1 argument(s) for 'budgeted', but got 0." The unknown-named-argument error lists only `callerSuppliedParameters`. A decorator call whose target lacks the shape skips the argument checks entirely: the shape error from the decorator stage already covers it, and checking against the wrong slots would add a second, misleading error.

### `raises`

`decoratorCarrying` in `raisesDiagnostic.ts` finds the first decorator on the def whose effects include the offending one, by tag name. The effect table is keyed by the name the file uses, imports and aliases included. When it finds one, the error is AG3030 and ends "It is raised by decorator 'budgeted'."

### `agency interrupts`

A block runs inside the handlers its callee puts around `block()`. The call graph records that, and a decorator's handler is listed for a raise in the body when it encloses every `block()` call in the decorator; `docs/dev/compiler/interrupts-command.md`, "Blocks run under their callee's handlers", has the rule and its one known gap. The effect walk above is a different analysis and still over-reports.

### `agency doc`

`generateFunctionSection` prints `AgencyGenerator.decoratorLines(fn)` above the signature, in the same fence. It reads `fn.decorators` and any decorator tags still on `fn.tags`, since `agency doc` lowers through `typeCheck` but carries on with an unlowered tree if `typeCheck` throws.

### Not done

Decorators on nodes, decorators that replace the function, and decorators that change tool metadata are out of scope by design.

# User-defined decorators

A decorator is an ordinary `def` whose last parameter is a block. Writing `@name(args)` above a function means "run my body as the block passed to `name`". Nothing else about the function changes: its name, docstring, parameters, tool schema, and `handoff`, `destructive`, and `idempotent` markers all stay on the `def`. The model never sees a decorator.

```
def logged(call: Call, block: () -> any): any {
  print("entering ${call.name}")
  const result = block()
  print("leaving ${call.name}")
  return result
}

@logged
def greet(name: string): string {
  return "hello ${name}"
}
```

Spec: `docs/superpowers/specs/2026-10-22-decorators.md`. Plan and review: `docs/superpowers/plans/2026-10-22-decorators.md` and `2026-10-22-decorators-review.md`. Tickets ADI-39 (this part) and ADI-40 (diagnostics, `agency doc`, the guide page).

## What the compiler does

The tag lowers to a call with the body as the block argument. `greet` above becomes:

```
def greet(name: string): string {
  return logged({ name: "greet", args: { name: name } }) {
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

1. **The `call` record.** A decorator whose first parameter is named `call` receives `{ name, args }`: the decorated function's name and its parameters by name, block-typed parameters left out (a block cannot be stored in a record). The record is passed as the first positional argument, before the tag's own arguments, so `@retry(3)` works as well as `@budgeted(cost: maxCost)`. `type Call` is in the prelude (`stdlib/index.agency`, listed in `PRELUDE_NAMES`). The rule goes by the parameter's name, not its type: a decorator written as `def tagWith(call: string, block: () -> any)` still receives the record in `call`, and `@tagWith("x")` then passes `"x"` where the block goes. Name the first parameter something else unless it is the record.

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

`decoratorProblems` reads tags wherever they are at the moment (standalone, attached, or already lowered), so it works before or after the lowering. The LSP gives the stage a range from the tag's location; `failIfNotCheckable` in `lib/compiler/typecheck.ts` treats the stage like a lift failure. When the editor keeps going past the failure, the checker's generic undefined-function warning may also fire on the lowered call; part 2 can suppress it.

Type mismatches (a tag argument of the wrong type, a body return that does not fit the block, a decorator whose return does not fit the def) are reported by the checker today through the ordinary call checks, anchored on the lowered call. Part 2 makes them point at the tag and name the decorator through `call.decorator` (`DecoratorOrigin` in `lib/types/function.ts`), which the lowering sets on every call it synthesizes.

## How effects reach a decorated function

The symbol table's effect walk (`lib/analysis/effects.ts`) runs over raw parse trees, before any lowering, and builds call edges from bodies. A decorated body never calls its decorator, so `summariesForFile` adds each decorator tag above a def as a callee of that def (`decoratorNamesByDef`). This is the same arrangement as `_guard` in `bodyFacts.ts`. All three views share it, so a `@budgeted` function carries `std::guard` in `agency doc`, in `agency policy gen`, in the static-init safety check, and in its host capabilities, and a `raises` clause that omits it is AG3013 (`lib/typeChecker/raisesDiagnostic.test.ts`). The type checker sees the lowered tree and finds the same edge on its own; `lib/analysis/effectsOracle.test.ts` compares the two.

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

## Files

- `lib/types/tag.ts`: `RESERVED_TAG_NAMES`, `isDecoratorTag`, `positionalTagArguments`, the widened `Tag.arguments`.
- `lib/parsers/parsers.ts`: `_tagParserInner`, `reservedTagArguments`, `decoratorTagArguments`.
- `lib/preprocessors/decoratorDesugar.ts` and its test.
- `lib/types/function.ts`: `FunctionDefinition.decorators`, `DecoratorOrigin`, `FunctionCall.decorator`.
- `lib/typeChecker/index.ts`, `lib/preprocessors/typescriptPreprocessor.ts`: the two call sites.
- `lib/compiler/prepareProgram.ts`: `DecoratorFailure` and the check; `lib/lsp/diagnostics.ts`, `lib/compiler/typecheck.ts`.
- `lib/compiler/buildSession.ts`: `checkDecoratorsOrExit`, the same check for `agency run` and `agency compile`.
- `lib/preprocessors/prunePreludeShadows.ts`: a local type or an import shadows a prelude name such as `Call`.
- `lib/analysis/effects.ts`: `decoratorNamesByDef`.
- `lib/backends/agencyGenerator.ts`: `formatTag`.
- `stdlib/index.agency` and `lib/prelude.ts`: `type Call`.
- Tests: `tests/agency/decorators/` (with `compile-errors/` for the checks through the CLI), `tests/agency-js/decorator-handoff/`, `tests/typescriptGenerator/decorators.agency`.

## Not in this part

Diagnostics that point at the tag, the `raises` message that names the decorator, decorator tags in `agency doc` output (read them from `fn.decorators`, since `agency doc` runs `typeCheck` and so lowers), the `agency interrupts` listing, and the guide page are ADI-40. Decorators on nodes, decorators that replace the function, and decorators that change tool metadata are out of scope by design.

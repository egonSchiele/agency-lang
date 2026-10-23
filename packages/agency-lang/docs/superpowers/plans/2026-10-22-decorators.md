# User-defined decorators — Implementation Plan (ADI-39 and ADI-40)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A decorator is an ordinary block-taking `def`. Writing `@budgeted(cost: maxCost, time: maxTime)` above a function means "run my body as the block passed to `budgeted`". The compiler lowers the tag to a call; the runtime, interrupts, checkpoints, and the tool schema see nothing new.

**Architecture:** Two PRs, each from `main`, never stacked. PR 1 (ADI-39) makes decorators work: the tag grammar accepts call arguments, a desugar pass rewrites a decorated body into `return decorator(call, ...args) { body }` the same way `guard { }` becomes `_guard(...) { }` today, the effect-propagation walk counts the decorator as a callee of the decorated function, the formatter prints the tag back, and a diagnostic names an unknown decorator. PR 2 (ADI-40) makes mistakes readable: three diagnostics that point at the tag and name the decorator, the `raises` error that says which decorator brought the effect, `agency interrupts` and `agency doc` output, and the guide page.

**Tech Stack:** tarsec parsers (`lib/parsers/parsers.ts`), the preprocessor passes under `lib/preprocessors/`, the symbol table's effect views (`lib/analysis/effects.ts`), the type checker (`lib/typeChecker/`), the Agency formatter (`lib/backends/agencyGenerator.ts`), execution tests under `tests/agency/`, scripted-model tests under `tests/agency-js/`.

**Spec:** `docs/superpowers/specs/2026-10-22-decorators.md` (a copy of the Linear project description of P-ADI-3, section "Design: user-defined decorators"). The rules there are settled; this plan says where each one lands in the code and records where the implementation has to differ from the spec's sketch (see "Decisions this plan makes").

**Review:** `2026-10-22-decorators-review.md` (2026-10-22). This revision of the plan folds its findings in: decisions 6 and 7 changed, the `agency doc` paragraph was corrected, three tests were added, and the shape of the lowering pass is now spelled out against `docs/dev/contributing/anti-patterns.md`.

---

## Background: how the pieces fit today

Read `docs/dev/compiler/effect-propagation.md` and `docs/dev/language/closures-and-lambdas.md` first. The rest of this section is what a worker needs from the code, verified on 2026-10-22 at commit `bf47fb34b` plus PR #1252.

**Tags.** `@name(args)` parses as a standalone `tag` node (`lib/types/tag.ts`: `{ name, arguments: Expression[], parentheses? }`). The parser accepts tags anywhere a body statement can go (`_bodyNodeParser`, `lib/parsers/parsers.ts:5989`), so `@x` before `export handoff def` already parses: the tag is a sibling node, the def follows. Tag arguments go through `restrictedTagArgParser` (`parsers.ts:2957`), which allows literals, identifiers, PFA expressions, arrays, objects, regexes, and unit literals, and refuses a bare call. No named arguments. Tags attach to the node below them in two places: `collectTags` in the preprocessor (`lib/preprocessors/typescriptPreprocessor.ts:169`, wrapping `attachTags` at line 107, during `preprocess()`), and the read-only helper `tagsAbove` (`lib/utils/tagsAbove.ts`) that the symbol table and the capabilities check use to see tags before anything attaches them. `agency doc` calls `attachTags()` and then `typeCheck()` (`lib/cli/doc.ts:369` and `:414`) to fill its Throws column, so it does run the checker's constructor and does lower. Unknown tag names are ignored everywhere today.

**The type checker is off by default.** `typechecker.enabled` defaults to `false` (`docs/dev/runtime/config.md:269`); this repo's `agency.json` turns it on, a user's project usually does not. A diagnostic that only the checker emits is invisible to that user. The two mistakes part 1 must catch (an unknown decorator, a decorator in the wrong place) are therefore reported from `prepareProgram` (`lib/compiler/prepareProgram.ts`), the one pipeline every build goes through, as a `PipelineDiagnostic` with its own stage, the way a refused callback block is (`LiftFailure`).

**No generics.** A `def` has no type parameters. A decorator's block parameter is one concrete type, so `def logged(block: () -> string): string` cannot wrap a function returning `number` (the body's returns are checked against the slot at `checker.ts:880`). See decision 7. The names in use: `capabilities`, `validate`, `jsonSchema`, `hidden` (`lib/utils/hiddenTag.ts`), `always` and `alwaysUnder` (`lib/typeChecker/alwaysTag.ts`), `optimize` (`lib/optimize/targets.ts`).

**The guard precedent.** `guard(...) { }` parses to a `guardBlock` node. `desugarGuardsInBody` (`lib/preprocessors/guardDesugar.ts`) rewrites it in place into a `functionCall` to `_guard` with a `blockArgument` holding the body. It runs twice on the same program object: in the `TypeChecker` constructor (`lib/typeChecker/index.ts:113`) and again in `TypescriptPreprocessor.preprocess()` (`typescriptPreprocessor.ts:345`). `compileSource` type-checks and then preprocesses the same `liftedProgram` (`lib/compiler/compile.ts:174`), so the pass must be idempotent, and it mutates in place because the `CompilationUnit` built beforehand holds references to the same def objects. The symbol table never sees the lowering: `collectBodyFacts` (`lib/analysis/bodyFacts.ts:116`) counts a `guardBlock` node as a call to `_guard`, which is how a function containing a guard gets `std::guard` in its effect set before any lowering runs.

**Blocks.** A call with a trailing block carries it at `call.block` (`lib/types/function.ts:114`), a `blockArgument` with `params` and `body`. The runtime binds it to the callee's last parameter (`docs/dev/language/agency-function.md`). The checker checks a block body's `return` statements against the last parameter's `blockType` (`lib/typeChecker/checker.ts:883`, via `getBlockSlot` in `lib/typeChecker/utils.ts:34`) and refuses a block passed to a function whose last parameter cannot take one (`checkBlockArgShape`). `checkNamedArgStructure` refuses a positional argument after a named one. A `finalize` at the top of a block body is legal (`finalizeChecks.ts:106`, and `tests/agency/guards/finalize-in-guard-block.agency` shows a guard's block salvaging through one). Interrupts inside a block resume through step counters (`tests/agency/blocks/block-inline-interrupt.agency`). `revise` in `stdlib/strategy.agency` calls its block more than once.

**Effects.** `propagateEffects` runs inside `SymbolTable.build` over raw parse trees. For each callable it reads `view.readBody(declaration.body).callees` (`lib/analysis/effects.ts:224`) and runs a worklist. A decorated function's raw body never calls the decorator, so without a change the decorator's effects, unanswered effects, and capabilities would be missing from the decorated function in every reporting consumer (`agency policy gen`, `agency doc` Throws, AG3013). The checker builds its own per-file call graph from the lowered tree and may find more, never fewer (the invariant at the end of the effect-propagation doc).

**Callee resolution in the checker.** `getParamsForNodeOrFunc` (`utils.ts:20`) looks a name up in `ctx.functionDefs`, `ctx.nodeDefs`, then `ctx.importedFunctions`. That is exactly the resolution a decorator name needs. The preprocessor has the same two tables (`this.functionDefinitions`, `this.importedFunctions`).

**Formatter.** `agency fmt` parses in template mode, never type-checks, and prints standalone tag nodes through `formatTag` (`agencyGenerator.ts:2210`), which runs each argument through `processNode`. The round-trip gate (`agencyGenerator.roundtrip.test.ts`) sweeps `stdlib/`, `tests/typescriptGenerator/`, and `tests/agency/templates/`.

**Known block bugs to test against** (`docs/dev/agents/agent-brains.md:165`): a `match` expression inside a block body kept its value on the enclosing frame (fixed per `tests/agency/match-expr-in-block.agency`, #928, but a decorated body is a new way to reach it), and `record.field(args) with approve` compiles wrong.

---

## Decisions this plan makes

These go beyond the spec or differ from its sketch. Each is flagged for the owner in Review Focus.

1. **The `call` record is passed positionally, first.** The spec sketch writes `budgeted(call: {...}, cost: maxCost)`. If the author's tag arguments are positional (`@retry(3)`), a named `call:` followed by a positional `3` is refused by `checkNamedArgStructure` and the runtime resolver alike. Passing the record as the first positional argument works with both positional and named tag arguments, and "the decorator's first parameter is named `call`" is the same rule. Documented as such.
2. **Decorators lower before guards.** `guardDesugar` stamps a return-position `guard` with the def's declared `Result<T>` success type. Once the body is inside the decorator's block, a `return guard(...) {}` yields to the block, not the def, so the stamp would be wrong. Lowering decorators first means the guard desugar meets the body inside a block argument and stamps nothing, which is what any other block gets today.
3. **A decorator tag on anything but a top-level `def` is an error** (new diagnostic, part 1). Today an unknown tag anywhere is ignored. Keeping that would mean `@budgeted` on a `node` silently does nothing. The reserved names keep their current behavior everywhere.
4. **The `args` record leaves out block-typed parameters.** A decorated function that itself takes a block would otherwise store a block in a record, which the block rules forbid. The parameter is still in scope inside the body.
5. **`type Call` lives in the prelude** (`stdlib/index.agency`) so `def budgeted(call: Call, ...)` works without an import, the way `Result` does.
6. **The desugar lowers blindly; `prepareProgram` reports the mistakes.** The desugar does not throw and does not resolve names beyond asking the lookup whether the first parameter is `call`. It wraps the body in a call to whatever name the tag has, so the pass stays as dumb as `guardDesugar`. A separate pure function, `decoratorProblems(program, unit)`, returns every unknown decorator, every decorator on something other than a top-level `def`, and every def that decorates itself, each with the tag's location. `prepareProgram` calls it after `buildCompilationUnit` and reports the results as a `"decorators"` pipeline stage, which fails a build and shows in the editor through `lib/lsp/diagnostics.ts`. The type checker adds nothing for these in part 1. (Earlier draft: the checker reported them. It is off by default, so a default user would have met a runtime "undefined function" error for a typo in a decorator name.)
7. **A reusable decorator types its block as `any`.** There are no generics, so a decorator written for `string` bodies is refused on a `number` body. A decorator meant for one return type (the `@budgeted` over `Result<string>` case) can type the block precisely and gets the body's returns checked against it. A decorator meant for every function (`@logged`, `@retry`) writes `block: () -> any): any`, and the body's returns are then unchecked, as for any `any` block today. Nothing in the language changes; the guide states the trade-off and the test set uses one `logged` with an `any` block throughout. A guard in return position inside a decorated body gets no yield stamp (decision 2); its `Result<T>` precision comes from the synthesizer's `_guard` case as it does for a guard inside any other block, and `guard-in-decorated-body` pins that.

---

## File structure

```text
PR 1 (ADI-39)
lib/types/tag.ts                               Tag.arguments widens to (Expression | NamedArgument)[]; argumentTrivia; RESERVED_TAG_NAMES; isDecoratorTag
lib/parsers/parsers.ts                         tag parser: reserved names keep the static parser; any other name takes argumentListParser (splats and inline blocks refused)
lib/parsers/tag.test.ts                        named and expression arguments on a user tag; static-only still enforced on @validate
lib/preprocessors/decoratorDesugar.ts          NEW: decoratorsAbove, loweredBody (pure), desugarDecorators (the one in-place write), decoratorProblems (pure)
lib/preprocessors/decoratorDesugar.test.ts     NEW: unit tests on the AST shape and on the problem list
lib/preprocessors/typescriptPreprocessor.ts    calls desugarDecorators after collectTags, before desugarGuards
lib/typeChecker/index.ts                       constructor: build the unit first, then desugarDecorators, then desugarGuards
lib/types/function.ts                          FunctionDefinition.decorators?: Tag[]; DecoratorOrigin type; FunctionCall.decorator?: DecoratorOrigin
lib/compiler/prepareProgram.ts                 DecoratorFailure stage; decoratorProblems reported after buildCompilationUnit
lib/lsp/diagnostics.ts, lib/compiler/typecheck.ts   the new stage gets a range and counts as "not checkable"
lib/analysis/effects.ts                        calleeKeys include the decorators of a def
lib/analysis/effects.test.ts                   a decorated function inherits the decorator's effects; the oracle test agrees
stdlib/index.agency                            export type Call = { name: string, args: object }
tests/agency/decorators/*.agency + .test.json  the execution tests (list in Task 6)
tests/agency-js/decorator-handoff/             decorated handoff def through the scripted tool loop; also pins the tool schema the model sees
tests/typescriptGenerator/decorators.agency    fixture: lowering shape and tool metadata in generated code, and the formatter round-trip corpus
docs/dev/language/decorators.md                NEW dev doc
docs/dev/compiler/effect-propagation.md        a row in the "which tree each side sees" table
CLAUDE.md, .claude/skills/agency-language-docs/SKILL.md   index lines

PR 2 (ADI-40)
lib/typeChecker/diagnostics.ts                 decoratorArgType, decoratorBodyReturn, decoratorReturnMismatch; raisesExceeded gains an optional "via" clause
lib/typeChecker/checker.ts                     the three call-check sites emit the decorator form when call.decorator is set
lib/typeChecker/raisesDiagnostic.ts            names the decorator whose effect set holds the exceeded effect
lib/typeChecker/*.test.ts                      one test per diagnostic
lib/analysis/interrupts.test.ts                a handler installed by a decorator is listed for an interrupt in the body
lib/cli/doc.ts                                 decorator tags printed above the signature
docs/site/guide/decorators.md                  NEW guide page
docs/site/.vitepress/config.mts                sidebar entry after Blocks
docs/dev/language/decorators.md                updated with what part 2 learned
```

## Global Constraints

- Every PR is based on `main`. PR 2 starts after PR 1 merges.
- Mutate the AST in place in the desugar, for the reason `guardDesugar.ts` gives in its header. The pass must be idempotent; it runs twice on the same program.
- The runtime does not change. If a test fails in a way that seems to need a runtime change, stop and report it; the design rests on blocks already working.
- Handlers are safety infrastructure. A decorator that wraps `block()` in `handle { } with ...` must have that handler on the chain when the body raises. Task 6 pins it.
- The symbol table must not under-report. After PR 1, `lib/analysis/effectsOracle.test.ts` must still pass with a decorated fixture added.
- Run `pnpm run typecheck` after every edit and `make` before every commit; the stdlib (`type Call`) compiles into `stdlib/index.js`. Save test output to a file. Run the specific execution tests, never the whole suite.
- Format changed `.ts` files by name with `npx prettier --write <files>`, never a directory and never `pnpm run fmt:ts` (it reaches `worktrees/`).
- Run `make -j siblings` from the repo root before pushing.
- Commit messages and PR bodies go in a file and are passed with `-F`.
- No `Map`, `Set`, `interface`, or dynamic import. Read `docs/dev/contributing/anti-patterns.md` before each task. Agency snippets in tests must be verified with `pnpm run ast`.

## Shape of the code, checked against the anti-pattern catalog

The catalog's rule that matters most here is "imperative code everywhere": keep the "what" separate from the "how", and put the imperative part in one place behind a declarative interface. The earlier draft of Task 2 was a numbered list of mutations, and Task 8 scattered `if (call.decorator)` across three checker sites. Both are rewritten below. The rules the implementation follows:

- **One pure "what" layer, one write.** `decoratorsAbove(nodes)` answers "which decorator tags sit on which def" (built on `tagsAbove`, never a second walk). `loweredBody(def, tags, lookup)` is a pure function from a def and its tags to the new body array; it builds the `call` record, the argument list, and the nested calls, and never touches the def. `desugarDecorators(program, lookup)` is the only function that mutates: for each entry it assigns `def.body`, `def.decorators`, `def.tags`, and filters `program.nodes`. The unit tests test `loweredBody` on its output and `desugarDecorators` only for idempotence and for leaving reserved tags where they were.
- **Problems are data.** `decoratorProblems(program, unit)` returns `{ message, loc }[]`. `prepareProgram` turns the list into diagnostics. The table from node type to phrase ("node 'main'", "type 'Foo'", "a statement") is one object literal, not a chain of ifs.
- **One lookup, built once.** `decoratorLookup(functionDefinitions, importedFunctions)` returns the function both callers pass, so the checker's and the preprocessor's inline lambdas cannot drift.
- **Named types, not nested literals.** `DecoratorOrigin = { name, tagLoc, target }` is its own exported type; `FunctionCall.decorator?: DecoratorOrigin`.
- **The same pattern as the neighbour.** The pipeline stage mirrors `LiftFailure`; the desugar mirrors `guardDesugar`'s header, in-place rule, and idempotence; the effect edge mirrors how `_guard` is credited in `bodyFacts.ts`.
- **For PR 2:** the three checker sites do not each grow an `if`. One helper, `blameFor(call)`, returns the location and subject phrase for a call (the tag and "decorator 'x' on 'f'" when `call.decorator` is set, the call itself otherwise), and the existing emits take their location and phrasing from it.

## Review Focus

- **Effect completeness.** A `@budgeted` function must carry `std::guard` in `agency doc`, in `agency policy gen`, and in AG3013, without the lowering having run. Task 4's symbol-table change is what does this; Task 6's `raises` test pins it. The walk cannot credit a handler the decorator installs around `block()`, so the body's effects are still reported on the decorated function; this is over-reporting, the safe direction, and the dev doc says so.
- **Mistakes are visible with the checker off.** Decision 6: `prepareProgram` reports an unknown decorator and a misplaced one. The tests for those run through `prepareProgram`, not `typeCheck`.
- **Decision 7.** Reusable decorators are typed with `any`. The maintainer may prefer one decorator per return type; the code is the same either way, the guide text differs.
- **Resume inside a decorated body.** The body is now a block argument. An interrupt in it, approved from outside, must resume at the right statement, including when the decorator calls the block a second time (`@retry`). Task 6 has both cases.
- **The seven decisions above**, in particular the positional `call` record (1), the error on a decorator in the wrong place (3), and `any`-typed reusable decorators (7).
- **Idempotence.** The checker and the preprocessor both lower. `decoratorDesugar.test.ts` runs the pass twice and compares.
- **Nothing reaches the model.** The tool schema of a decorated function is unchanged; `tests/agency/decorators/schema-unchanged` pins it.

---

# PR 1: decorators work (ADI-39)

### Task 1: The tag grammar accepts call arguments on user tags

**Files:**
- Modify: `lib/types/tag.ts`
- Modify: `lib/parsers/parsers.ts` (around lines 2957–2993)
- Modify: `lib/parsers/tag.test.ts`

**Interfaces:**
- `lib/types/tag.ts` exports `RESERVED_TAG_NAMES = ["capabilities", "validate", "jsonSchema", "hidden", "always", "alwaysUnder", "optimize"]` and `isDecoratorTag(tag): boolean` (name not reserved). `Tag.arguments` becomes `(Expression | NamedArgument)[]`, and `Tag.argumentTrivia?: ListTrivia[]` is added.
- The tag parser reads the name, then chooses the argument parser by name: a reserved name keeps `restrictedTagArgParser` (so `@validate(min(1))` is still refused with today's message); any other name takes `argumentListParser` (`parsers.ts:3178`), the ordinary call argument list. That list also admits splats and inline blocks (`ArgWithBlock`); the tag parser refuses both with a message ("a decorator argument cannot be a splat or a block"), so `Tag.arguments` stays narrower than `FunctionCall.arguments`. Store `argumentTrivia` on the tag when the list parser yields it, so the formatter keeps comments.

- [ ] **Step 1: Add the reserved list and the type change**

Every consumer of `Tag.arguments` that assumes `Expression` must still compile: `readCapabilities` filters with `isIdentifier`, `validationDescriptor.ts` and `mergeTags.ts` filter by name first. Run `pnpm run typecheck` and fix any site that indexes `arguments` without narrowing.

- [ ] **Step 2: Split the argument parser by name**

In `_tagParserInner`, after capturing `name`, pick the list parser with a small combinator that reads the captured name. If tarsec's `seqC` cannot branch on an earlier capture, parse the name first in a hand-written parser function the way `guardBlockParser` does (`parsers.ts:6441`): parse `@name`, then call one of the two list parsers on the rest.

- [ ] **Step 3: Parser tests**

In `tag.test.ts`: `@budgeted(cost: maxCost, time: maxTime)` yields two `namedArgument` nodes; `@retry(3)` yields a number; `@log("start", level: 2)` yields positional then named; `@validate(min(1))` still fails with the static-argument message; `@capabilities(terminal)` unchanged. Run `pnpm vitest run lib/parsers/tag.test.ts lib/parsers > /private/tmp/claude-501/tagparse.txt 2>&1`.

- [ ] **Step 4: Formatter round trip**

`formatTag` printed each argument through `processNode`, which does NOT handle a bare `namedArgument` (found while implementing); it now renders the list through `renderArgList`, the same path a call uses. Add to `lib/backends/agencyGenerator.roundtrip.test.ts` nothing yet; Task 7 adds the fixture file that the corpus sweep picks up. Confirm `pnpm run fmt` on a scratch file inside the package prints `@budgeted(cost: maxCost, time: maxTime)` back.

- [ ] **Step 5: Commit**

`parser: user tags take ordinary call arguments; the three built-in tags stay static (ADI-39)`

---

### Task 2: The lowering pass

**Files:**
- Create: `lib/preprocessors/decoratorDesugar.ts`, `decoratorDesugar.test.ts`
- Modify: `lib/types/function.ts`
- Modify: `lib/utils/tagsAbove.ts`
- Modify: `stdlib/index.agency` (`export type Call = { name: string, args: object }` near `WriteMode`, line 68, with a doc comment)

**Interfaces:**
- `decoratorsAbove(nodes: AgencyNode[]): { def: FunctionDefinition, tags: Tag[] }[]` in `tagsAbove.ts`: for each top-level `function` node, the decorator tags (per `isDecoratorTag`) from the standalone tags above it and from `def.tags` (in case `collectTags` already attached them), outermost first in source order. Excludes tags already recorded on `def.decorators`.
- `type DecoratorLookup = (name: string) => { parameters: FunctionParameter[]; imported: boolean } | undefined`, and `decoratorLookup(functionDefinitions, importedFunctions): DecoratorLookup`, the one constructor for it that both callers use.
- `loweredBody(def, tags, lookup): AgencyNode[]`, pure. What it returns, for tags `[outer, inner]` on `def f(a, b)`:
  - the innermost call's block body is `def.body` (the same array object, so the checker's existing references stay valid); each outer call's block body is `[ returnStatement(innerCall) ]`; the result is `[ returnStatement(outermostCall) ]`.
  - a call for tag `t` named `n` is `{ type: "functionCall", functionName: n, arguments: [callRecord?, ...t.arguments], block: { type: "blockArgument", inline: false, params: [], body }, scope: "imported" when the lookup says so, loc: t.loc, decorator: { name: n, tagLoc: t.loc, target: f } }`. The `call` record is present when `lookup(n)?.parameters[0]?.name === "call"`: an object literal `{ name: "f", args: { a: a, b: b } }` over the def's non-block parameters, variadic included.
- `desugarDecorators(program, lookup): AgencyProgram`, the one function that writes. For each entry of `decoratorsAbove(program.nodes)`: `def.body = loweredBody(...)`, `def.decorators = tags`, `def.tags` keeps only the reserved tags in their original order, and the standalone tag nodes are filtered out of `program.nodes`. `def.decorators` is the idempotence mark: a second run finds no decorator tags above or on the def.
- `FunctionDefinition.decorators?: Tag[]` (what was lowered; `agency fmt` never lowers so never sees it; `agency doc` reads it). `export type DecoratorOrigin = { name: string; tagLoc: SourceLocation | undefined; target: string }` in `lib/types/function.ts`; `FunctionCall.decorator?: DecoratorOrigin` marks a synthesized call, the way `synthetic` marks `__objectRest`.
- `decoratorProblems(program, unit): { message: string; loc: SourceLocation | undefined }[]`, pure. Three kinds: a decorator name the unit's `functionDefinitions`, `graphNodes`, and `importedFunctions` do not know ("Unknown decorator '{name}' on '{target}'. A decorator is a def whose last parameter is a block; declare or import '{name}'."); a non-reserved tag whose node is not a top-level `function` ("'@{name}' is written on {what}, but a decorator goes on a def.", `what` from a table keyed by node type, "a statement" otherwise, and "nothing" for a stranded tag); a def whose decorator is itself ("'{name}' cannot decorate itself."). Read from `tagsAbove` and `def.tags`/`def.decorators` so it works before or after the lowering.
- In the checker, the constructor builds `resolved` first (`info ?? buildCompilationUnit(program)`) and passes `decoratorLookup(resolved.functionDefinitions, resolved.importedFunctions)`; in the preprocessor, `getFunctionDefinitions()` moves above the desugar and the lookup is built from `this.functionDefinitions` and `this.importedFunctions`.

- [ ] **Step 1: Write the pass and its unit tests**

Unit tests parse a string with `parseAgency` and test `loweredBody` with a stub lookup on its output: one decorator with `call`; one without; two stacked (`@a @b def f` gives `a(...) { return b(...) { body } }`); positional tag args keep the record first; a `def` with a block parameter leaves it out of `args`; the innermost block body is the def's original array. Then `desugarDecorators`: a decorator tag on a `node` is left alone; a `@validate` above, between, and below two decorators stays on `def.tags` in order; the pass run twice produces the same tree (`JSON.stringify` equal). Then `decoratorProblems`: unknown name, decorator on a node, on a type alias, stranded at end of file, self-decoration, and a clean program yields `[]`. Verify the Agency inputs with `pnpm run ast` first.

- [ ] **Step 2: `type Call` in the prelude**

Add it with a doc comment saying what `name` and `args` hold and that `args` has the decorated function's parameters by name. Run `make`.

- [ ] **Step 3: Commit**

`preprocessor: lower a decorator tag on a def into a block call (ADI-39)`

---

### Task 3: Wire the pass into the checker and the preprocessor

**Files:**
- Modify: `lib/typeChecker/index.ts` constructor (lines 100–126)
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` `preprocess()` (lines 333–345)

- [ ] **Step 1: The checker**

Reorder the constructor: build `resolved` first, then `desugarDecorators(program, lookup)`, then `desugarGuardsInBody`. Update the long comment above it to say why decorators go first (decision 2) and that both passes are idempotent. `buildCompilationUnit` reads `functionDefinitions` by reference, so the in-place body rewrite is visible to the checker's `functionDefs` table; add a unit test in `lib/typeChecker/` that type-checks a decorated function and asserts the body it checks starts with a `returnStatement` whose value is the decorator call.

- [ ] **Step 2: The preprocessor**

In `preprocess()`: after `collectTags`, call `getFunctionDefinitions()` and `getGraphNodeDefinitions()` (move the two `if` blocks up), then `desugarDecorators`, then `desugarGuardsInBody`. Note in the comment that `collectTags` has by then attached the decorator tags to `def.tags`, which `decoratorsAbove` reads.

- [ ] **Step 3: Compile a decorated program end to end**

Write `tests/agency/decorators/log-around.agency` (Task 6 lists it) now and run `pnpm run preprocess` on it to see the lowered tree, then `pnpm run agency` on it. Expected: the decorator's prints bracket the body's output.

- [ ] **Step 4: Commit**

`compiler: decorators lower in the checker and the preprocessor, before guards (ADI-39)`

---

### Task 4: The symbol table counts a decorator as a callee

**Files:**
- Modify: `lib/analysis/effects.ts` (the declaration reader at line 215–227)
- Modify: `lib/analysis/effects.test.ts`, `lib/analysis/effectsOracle.test.ts` (add a decorated fixture)
- Modify: `docs/dev/compiler/effect-propagation.md` (table row and a short paragraph under "Why `_guard` is read, not walked" or beside it)

- [ ] **Step 1: Add the edge**

Where `calleeKeys` is built, append `keyOf(resolve(name))` for each decorator name from `decoratorsAbove(program.nodes)` for that def. All three views (`interruptEffects`, `unansweredEffects`, `capabilities`) share this reader, so one change covers Throws, static-init safety, and host capabilities. Use the same helper the desugar uses so the two cannot drift.

- [ ] **Step 2: Tests**

In `effects.test.ts`: `def deco(block: () -> string): string { interrupt std::read("x"); return block() }` and `@deco def f(): string { return "y" }` gives `f` the effect `std::read`; an imported decorator across two files does too (the issue-680 shape). The oracle test gets the same fixture and must agree. Run both files with output saved.

- [ ] **Step 3: The doc**

Table row: `decorator lowering | in the TypeChecker constructor and the preprocessor | counts each decorator tag on a def as a call to the decorator`. One paragraph: why the walk reads tags (the raw tree has no call) and that the same helper feeds both the lowering and the walk.

- [ ] **Step 4: Commit**

`effects: a decorated function inherits its decorator's effects before any lowering runs (ADI-39)`

---

### Task 5: `prepareProgram` reports an unknown or misplaced decorator

**Files:**
- Modify: `lib/compiler/prepareProgram.ts` (a `DecoratorFailure = { stage: "decorators"; message: string; loc?: SourceLocation }` in `PipelineDiagnostic`; after `buildCompilationUnit`, `decoratorProblems(program, info)` becomes one failure each; the first stops a build, all are kept under `keepGoing`)
- Modify: `lib/lsp/diagnostics.ts` (the stage gets a range from `loc`, like `lift`) and `lib/compiler/typecheck.ts` (`failIfNotCheckable` treats the stage like `lift`)
- Modify: `lib/compiler/prepareProgram.test.ts`

`decoratorProblems` itself is Task 2's. This task only wires it in. The type checker's generic undefined-function warning may also fire on the lowered call when the editor keeps going past the failure; that is acceptable for part 1 and noted in the dev doc.

- [ ] **Step 1: The stage and the wiring**
- [ ] **Step 2: Tests** in `prepareProgram.test.ts`: unknown name fails the build with a message naming the decorator and the def; decorator on a node fails; a clean decorated program prepares. Each asserts the stage and that `loc` is the tag's.
- [ ] **Step 3: Commit**

`compiler: prepareProgram refuses an unknown or misplaced decorator (ADI-39)`

---

### Task 6: Execution tests

**Files:** `tests/agency/decorators/<name>.agency` and `<name>.test.json`, one pair each. Use the `interruptHandlers` field as `tests/agency/blocks/block-inline-interrupt.test.json` does. Verify each file with `pnpm run ast` before writing its expectation, and run each with `pnpm run agency test tests/agency/decorators/<name>.agency > /private/tmp/claude-501/<name>.txt 2>&1`.

- [ ] **`log-around`**: `def logged(block: () -> any): any` appends "before" and "after" around `block()` to a module-level array; `@logged def greet(name: string): string`. Node returns the array plus the result. The `any` block is decision 7, and the same `logged` is reused by every test below that needs a plain decorator.
- [ ] **`guard-in-decorated-body`**: a `@logged` function declared `Result<string>` whose body is `return guard(cost: $1.00) { return "ok" }`; expect the success. Pins decision 2's consequence: the guard loses its yield stamp and still works.
- [ ] **`interrupt-resumes`**: the decorated body raises `interrupt("ok?")` between two counter increments; the test approves; the result shows each increment ran once.
- [ ] **`retry-calls-block-twice`**: `def retry(times: number, block: () -> Result): Result` loops `times`, returns the first success. The body fails on attempt 1 and raises an interrupt on attempt 2, then succeeds. Approve; expect the success and an attempt counter of 2.
- [ ] **`stacked-order`**: `@outer @inner def f()`; each decorator appends its name on entry and exit to a module-level array; expect `["outer:in", "inner:in", "body", "inner:out", "outer:out"]`.
- [ ] **`call-record`**: `def named(call: Call, block: () -> string): string { return "${call.name}:${call.args.a}" }`, `@named def f(a: number, b: string = "x")`, called directly as `f(a: 1)` and through `f.partial(a: 2)()`; expect `"f:1"` and `"f:2"`.
- [ ] **`finalize-in-body`**: `@budgeted`-shaped decorator over `guard` with a tiny cost; the body has a `finalize { return "draft" }`; expect the draft through the decorator's `Result`. Copy the shape of `tests/agency/guards/finalize-in-guard-block.agency`.
- [ ] **`destructive-region-in-body`**: a decorated body with `destructive { return failure("boom") }`; expect `destructiveRan` true on the failure, as `tests/agency/destructive-block.agency` checks. If this fails, stop and report; it is a finding about regions inside block arguments, not something to patch here.
- [ ] **`match-in-body`**: a `match` expression assigned to a local inside the decorated body, then returned; expect the value, not null.
- [ ] **`through-record-field`**: `const tools = { f: f }` where `f` is decorated; call `tools.f(1)` and expect the decorated result. Bind to a local before any `with approve`, per the known bug.
- [ ] **`handler-in-decorator`**: `def approving(block: () -> string): string { return handle { block() } with approve }`; the body raises `std::env` through `env("HOME")`; no `interruptHandlers` in the test; expect the body to complete. Then a second node where the decorator's handler is `with reject`; expect the rejection. This pins that the decorator's handler is on the chain.
- [ ] **Schema unchanged**: there is no schema helper in `std::agency`, so this is pinned in two existing places instead of a new test: the `tests/typescriptGenerator/decorators.agency` fixture (Task 7) shows the tool metadata of a decorated def next to an undecorated twin, and the `decorator-handoff` agency-js test below records the tool definitions the scripted model received and asserts the decorated tool's parameters are the def's own.
- [ ] **`decorated-block-taker`**: `@logged def each(xs: number[], block: (number) -> number): number[]` whose body calls `block(x)`; expect the mapped values. This exercises `blockDepth` resolution for a block parameter used inside a decorator's block.
- [ ] **`raises-must-list-decorator-effect`**: a type-check test in `lib/typeChecker/raisesDiagnostic.test.ts`: `@budgeted def f(): Result raises <std::read>` gets AG3013 for `std::guard`. This is the effect-completeness pin and belongs with the other raises tests, not under `tests/agency/`.
- [ ] **`tests/agency-js/decorator-handoff/`**: copy the layout of `tests/agency-js/handoff/` (scripted model via `llmMocks.json`). A `handoff def` decorated with `logged` is called as a tool; the caller's thread shows the handoff marker and the decorator's prints appear once. Read `docs/dev/language/handoff-functions.md` first for which marks count; if `handBack` inside the block does not count, that is a finding to report with the test, not to fix here.
- [ ] **Commit:** `tests: decorators across interrupts, retries, stacking, handoff, and the known block bugs (ADI-39)`

---

### Task 7: Fixture, formatter corpus, dev doc, and the PR

**Files:**
- Create: `tests/typescriptGenerator/decorators.agency` (a `logged` decorator with `call`, two stacked uses, named and positional tag arguments, one on an `export handoff def`), then `make fixtures` writes its `.mjs`
- Create: `docs/dev/language/decorators.md`
- Modify: `CLAUDE.md` index (under "Language semantics and syntax features", alphabetical, after `closures-and-lambdas.md`) and `.claude/skills/agency-language-docs/SKILL.md`, identical lines

- [ ] **Step 1: The fixture**

`make fixtures`; read the generated `.mjs` once to confirm the body is `return logged(...)` with the block lifted the way `_guard`'s is. The round-trip test picks the file up automatically; run `pnpm vitest run lib/backends/agencyGenerator.roundtrip.test.ts`.

- [ ] **Step 2: The dev doc**

Sections: what a decorator is (one example); the lowering (before and after, as in the spec); the seven decisions above with their reasons; why a decorator's handler is not credited by the effect walk; where the pass runs and why twice; how effects reach the decorated function without the lowering; what the LLM sees; the block rules that apply; what is not supported (nodes, replacing the function, changing tool metadata); the test list. Follow `docs/dev/contributing/general-writing-tips.md` and cut the phrases in `verbal-tics.md`.

- [ ] **Step 3: Verify and open the PR**

`make && pnpm run typecheck && pnpm run lint:structure`, `pnpm test:run` saved to a file, `make fixtures` clean, `make -j siblings` from the repo root, `npx prettier --check` over every `.ts` touched. PR title `User-defined decorators: lowering, effects, and tests (ADI-39)`. Body: the seven decisions, the test list, and the two "stop and report" findings if either fired. Tell the owner; do not merge.

---

# PR 2: decorators are pleasant to use (ADI-40)

Starts from `main` after PR 1 merges.

### Task 8: Three diagnostics that point at the tag

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts`, `diagnosticExplanations.ts`
- Modify: `lib/typeChecker/checker.ts` at the three sites below
- Tests: `lib/typeChecker/decoratorChecks.test.ts`

**Interfaces** (each at `call.decorator.tagLoc`):
- `decoratorArgType`: "Decorator '{name}' expects '{param}: {expected}', got '{actual}'." Emitted where the per-argument type check runs for a call that carries `decorator`; the ordinary argument-type diagnostic is suppressed for that call.
- `decoratorBodyReturn`: "The body of '{target}' returns '{actual}', but decorator '{name}' takes a block returning '{expected}'." Emitted from the `"block return"` branch in `checkExpressionsInScope` (`checker.ts:883`) when the enclosing call (`findEnclosingBlockSlot`'s parent) carries `decorator`. Anchor at the offending `return`, and mention the tag line in the message.
- `decoratorReturnMismatch`: "'{target}' is declared to return '{declared}', but decorator '{name}' returns '{actual}'." Emitted from `checkReturnTypesInScope` for the lowered `return decorator(...)` when the call carries `decorator`.

- [ ] **Step 1: One `blameFor(call)` helper, used at the three sites.** It returns `{ loc, subject }`: the tag's location and "decorator 'x' on 'f'" when `call.decorator` is set, the call's own location and name otherwise. Find the exact emit points by grepping the existing diagnostic names at those sites (`argTypeMismatch` or its equivalent, the `"block return"` context string, and the `return in '…'` context string) and have each take its location and phrasing from the helper. No site grows an `if (call.decorator)` of its own; that is the "imperative code everywhere" anti-pattern.
- [ ] **Step 2: Also check the block body against the block parameter type for any user-defined block-taking function**, not only `_guard`. `getBlockSlot` already does this for any name with a `blockType` last parameter; write a test with a plain (undecorated) call to confirm, and if it holds, record in the dev doc that nothing was needed.
- [ ] **Step 3: One test per diagnostic**, asserting code, message substrings, and that `loc.line` is the tag's line (or the return's line for the body case).
- [ ] **Step 4: Commit** `typechecker: decorator mismatches point at the tag and name the decorator (ADI-40)`

### Task 9: The `raises` error names the decorator

**Files:** `lib/typeChecker/raisesDiagnostic.ts`, `diagnostics.ts`, `raisesDiagnostic.test.ts`

- [ ] **Step 1:** In `checkRaisesDeclarations`, for a function with `decorators`, when an exceeded effect is in `interruptEffectsByFunction[<decorator name>]`, emit `raisesExceeded` with an added `via` placeholder: "… Add '{effect}' to the clause.{via}" where `via` is " It is raised by decorator '{name}'." or empty. Keep AG3013's code; a second message template with an optional suffix is the pattern `validNamesSentence` used in PR #1253.
- [ ] **Step 2:** Test: the pin from Task 6 now also asserts the suffix. Run the raises test file.
- [ ] **Step 3: Commit** `typechecker: a raises error says which decorator brought the effect (ADI-40)`

### Task 10: `agency interrupts` and `agency doc`

**Files:** `lib/analysis/interrupts.test.ts`, `lib/cli/doc.ts`, a doc test if one exists for function sections (grep `generateFunctionSection` in `lib/cli/*.test.ts`)

- [ ] **Step 1: interrupts.** Add a case: a decorator with `handle { block() } with approve` around a body that raises `std::env`. The command runs `typeCheck`, whose constructor lowers, so the handler should be listed as "handle block at <decorator file>:<line>". If the handler is not listed, the edge from the decorator's `block()` call to the block argument body is missing in `interruptCallGraph` (`functionTypeRaises.ts:89` is where a call's block meets its parameter type); fix there and add the case to `docs/dev/compiler/interrupts-command.md`.
- [ ] **Step 2: doc.** In `generateFunctionSection` (`doc.ts:713`), print the decorator tags from `fn.decorators` as lines above the signature inside the same code fence, using `generator.formatTag`. (`agency doc` runs `typeCheck` at `doc.ts:414`, whose constructor lowers, so by this point the tags have moved from `fn.tags` to `fn.decorators`.) Check that the section renders nothing from the body: the body is the lowered form by then. Built-in tags stay hidden as today. Docstrings unchanged. Run `make doc` on a stdlib file with no decorators to confirm no page changes, then on the fixture from Task 7 through `agency doc tests/typescriptGenerator/decorators.agency -o <scratch>` and read the output.
- [ ] **Step 3: Commit** `agency interrupts and agency doc see decorators (ADI-40)`

### Task 11: The guide page, the sidebar, and the dev doc

**Files:** `docs/site/guide/decorators.md`, `docs/site/.vitepress/config.mts` (after `{ text: "Blocks", link: "/guide/blocks" }` at line 73), `docs/dev/language/decorators.md`

- [ ] **Step 1: The guide.** Front matter like `blocks.md`. Sections: writing a decorator (`@budgeted` over `guard`, then `@retry`); what the compiler does (the before and after); the `call` record; stacking order; the block rules that apply (never store or return the block; may call it more than once); the LLM never sees a decorator; what you cannot do (nodes; replacing the function; changing the name, docstring, schema, `handoff`, `destructive`, `idempotent`). Every snippet verified with `pnpm run ast`.
- [ ] **Step 2: Build the site** with `npx vitepress build` from `docs/site` and check the sidebar.
- [ ] **Step 3: Update the dev doc** with whatever Tasks 8–10 found (the Task 8 Step 2 result, the interrupts edge if it needed fixing).
- [ ] **Step 4: Verify and open the PR** as in Task 7. Title `Decorators: diagnostics, raises, doc output, and the guide (ADI-40)`. Do not merge.

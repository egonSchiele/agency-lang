# Review: The `decorator` keyword plan

Plan: `docs/superpowers/plans/2026-10-24-decorator-keyword.md`
Spec: `docs/superpowers/specs/2026-10-24-decorator-keyword.md`
Reviewed 2026-10-24 against `origin/main` at `095148f78`. The files the plan cites have no diff between this worktree's branch and `main`, so its line numbers hold.

I checked the plan's references against the code. These are right: `FUNCTION_MARKER_KEYWORDS` and `FunctionMarkers` at `lib/types/function.ts:115-135`; the three helpers at `:47-87`; the parser ordering loop at `parsers.ts:7539`; `paramDefaultOrder.ts:25`; `checker.ts:320-332, 750, 757`; the LSP dedupe at `lsp/diagnostics.ts:127-131`; the re-export marker copy at `resolveReExports.ts:243`; the symbol table copy at `symbolTable.ts:470`. AG6044 is free. `make diagnostics-docs` exists. The order message for `def decorator d` comes for free from `declNameParserFor("def", FUNCTION_MODIFIER_KEYWORDS)` at `parsers.ts:1417`.

The findings below are where the plan and the code disagree, or where following the plan as written leaves something broken.

## Must fix before executing

### 1. The branch was squash-merged; start from `main`

PR #1269 merged as `3d8d4bdfe`. This worktree's branch, `adit/decorator-shape`, is not an ancestor of `main`. A PR opened from it would show all of #1269's commits again. The plan's last step says "Open the PR against `main`" but never says which branch to work on.

Add a step 0: make a new worktree and branch off `origin/main`, and copy the spec and plan into it (both are untracked here).

### 2. Tasks 2 through 5 leave the stdlib unparseable

The previous review found the same problem in the previous plan.

After Task 2, the parser exempts the last two parameters from the required-after-optional check only when the def says `decorator`. `stdlib/strategy.agency:202` does not say it until Task 6:

```
export def guarded(
  cost: number | null = null,
  time: number | null = null,
  label: string | null = null,
  call: Call,
  block: (args: object) -> any,
)
```

From Task 2 on, this fails to parse with "Required parameter 'call' cannot follow optional parameter". Nine agents in `stdlib/agents/` import `guarded`, so `make` fails, and so does anything that reads `std::strategy`. `tests/agency/decorators/defaults-before-call.agency` breaks the same way. Task 4 Step 5 already admits "the other decorator fixtures fail until Task 6".

Fix: move Task 6 Step 2 (adding the keyword to the stdlib, fixtures, and test sources) into Task 1. After Task 1 the parser accepts the keyword and the old name-based detection still runs, so every source keeps working with or without it. Each later task then lands green and can be bisected. Task 6 is left with the three new tests, `make fixtures`, and the doc check.

### 3. `typeReference` is not an AST type

Task 2's Interfaces say the fill uses `{ type: "typeReference", name: "Call" }`, and `decoratorShapeProblem` checks for "the type reference `Call`". Nothing in `lib/types/` has that name. A named type parses as `{ type: "typeAliasVariable", aliasName: "Call" }` (`lib/types/typeHints.ts:311-312`). Written as the plan says, the record-slot check would refuse every `call: Call`, including all 37 existing fixtures.

There is also no `parseTypeHint`. The type parser is `variableTypeParser`, which `lib/parsers/typeHints.test.ts:17` imports. Name it in the plan so the implementer does not have to look for it.

### 4. A local decorator with a bad shape gives extra errors at every tag

Task 5 says the checker's call branch reports a local decorator's shape at the def (`checkDecoratorDefs`) "not here". The branch then goes on to check the call's arguments. Task 2 makes `hiddenDecoratorArguments` a constant 2. So for

```
decorator def d(block) { return block() }

@d
def f(): string { return "x" }
```

the def gets AG6043. Then the tag's call `d(call: __call_0) { ... }` is checked against a one-parameter signature: `call` is an unknown named argument, and the arity check fails. The old code returned early on a bad shape for exactly this reason (the comment at `checker.ts:320-323`: "checking its arguments against the wrong slots would add a misleading error").

Fix: in the call branch, when the target is a decorator with a shape problem, return. Push AG6043 only when it is imported. Add a test that the example above gives one error.

### 5. The re-export case has no runtime test, and the re-export wrapper is a new path

Review Focus item 4 says a re-exported decorator "works end to end" and points at Task 6. Task 6 only creates a two-file test. The re-export check is in Task 3, as a unit test of the compilation unit.

The runtime path is different for a re-export. `buildFunctionWrapper` (`resolveReExports.ts:216`) makes a wrapper def that passes every parameter positionally: `def logged(call, block) { return __reexport_logged(call, block) }`. The markers are copied onto the wrapper (`:243`), so after this plan the wrapper is a `decorator def`. Its block is filled with a block type and passed on as an ordinary positional argument, not as a block. Nothing tests that today, because no fixture imports a decorator at all.

Add `reexported-decorator.agency` with a lib file and a middle file, beside `imported-decorator.agency`.

## Should fix

### 6. One AG6043 message cannot say both things

The spec's table gives AG6043 one message: `'{name}' is declared as a decorator, but {problem}`. Spec section 5 and Task 4 give an imported decorator with a bad shape a different message at the tag: `'d' cannot decorate 'f': {problem}`. Task 5 has the checker push `decoratorShape` for that case, which would print the "is declared as a decorator" text. The stage and the checker would then disagree on the wording for the same mistake.

The simplest fix is to use the "is declared as a decorator, but" message in both places, at the tag for an import. It reads correctly there too, and AG6043 keeps one message.

### 7. `ImportedFunctionSignature.markers` is a second way to carry markers into the unit

`compilationUnit.ts:181-200` has `registerMarkers`, with a comment saying it is the one place for all three ways markers enter the unit (local defs, destructive imports, resolved Agency imports), "so a future marker is a one-field change here rather than another parallel-mirror pass". The plan adds a separate `markers` field on the imported signature instead.

Either is workable. If the plan keeps the new field, say why in the plan and update that comment, so the next marker does not have two places to choose from. If it uses `registerMarkers`, add `unit.decoratorFunctions: Record<string, boolean>` and have `decoratorLookup` read it.

### 8. Files the plan does not list

- `tests/agency-js/decorator-handoff/agent.agency` declares a decorator. Task 6's grep over `tests` would find it, but the Files list and the test commands do not include it. Add it, and run `pnpm run agency test js tests/agency-js/decorator-handoff`.
- `stdlib/index.agency:71`, the doc comment on `type Call`, says "Every decorator receives one of these in `call`, its second-to-last parameter". After this change the slot can have any name. Add it to Task 7.
- The doc comment on `decoratorProblems` (`decoratorDesugar.ts:271-285`) lists "a decorator without the decorator shape: its own parameters, then `call: Call`, then a block". Task 4 should rewrite it.
- `make` copies `docs/site/guide` and `docs/site/diagnostics` into `stdlib/docs/` (`Makefile:32-35`). After Tasks 5 and 7, commit the copies too, or CI's freshness checks will see a stale tree.
- `dec.agency` in the main checkout's package root is the owner's example file. The decorator-shape memory says it should be updated once the shape changes. It is untracked, so it is not part of the PR; mention it to the owner.

### 9. The fill gives the decorator two views of its parameters

Task 3 replaces `def.parameters` with a filled copy. The symbol table built before the lowering keeps the original array (`symbolTable.ts:470` stores `node.parameters` by reference). So in the decorator's own file, the def says `call: Call` and the symbol says `call` with no type. The copy is the right call, since mutating the array would leak the types into an importing file's view and into anything that prints the parse. The dev doc (Task 7 Step 2) should say which consumers read which view. One consumer to check is the generated tool schema: a decorator def is a tool like any def, and the fill changes its untyped `call` parameter into an object schema.

Also state in the plan that the fill loop must run before the lowering loop. A decorator that is itself decorated gets a record built from its own parameters, and `callRecord` leaves block-typed parameters out (`decoratorDesugar.ts:215`). If the fill runs first, an untyped `block` is filled with a block type and left out of the record. If it runs second, the block function value goes into `call.args`. Task 3 Interfaces say "before lowering the decorated defs", which is right. Add a test with a decorated `decorator def` whose slots are untyped, so that order is pinned.

## Small things

10. Review Focus item 2 says `body()` and `body(ctx.args)` both run. `free-slot-names.agency` calls `body(ctx.args)` and `body({ ...ctx.args, n: ... })`, never `body()`. Change one of the two, so the item and the test agree.

11. The variadic clause in `decoratorShapeProblem` can only fire for the block slot from source. The parser already refuses a variadic parameter that is not last (`parsers.ts:7531-7536`), so `decorator def d(...rest, block)` never reaches the shape check. The unit test with `rest` as the record slot is fine as a test of the helper. Add a compile-error fixture for `decorator def d(call, ...block)`, the case a user can write.

12. Task 2 Step 4 makes `hiddenDecoratorArguments` a constant 2 before Task 5 adds the not-a-decorator early return. A tag on a plain def is miscounted for three commits. The decorator stage catches it first in every real caller, so nothing breaks. Combined with finding 2 it costs nothing to do both changes in Task 2.

## What I did not check

I did not run any tests or builds. Finding 2 comes from reading `parsers.ts:7531-7550` and `strategy.agency:202-208`. To confirm it, add the Task 2 change to `callerSuppliedParameters` and run `pnpm run ast stdlib/strategy.agency`. Finding 4 comes from reading `checker.ts:320-336` and `:747-752`. Finding 5's wrapper behavior comes from `resolveReExports.ts:205-245`; I did not compile a re-export to see what the wrapper generates.

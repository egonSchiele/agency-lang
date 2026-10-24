# Decorator Shape and Arguments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Agency decorator one shape (its own parameters, then `call: Call`, then the block), let the body block take a record of arguments so a decorator can change what the body runs with, and rename the stdlib `@guard` decorator to `@guarded`.

**Architecture:** The decorator lowering (`lib/preprocessors/decoratorDesugar.ts`) already rewrites a tag into a call with the body as a block. This plan changes what that call looks like (the record becomes a named argument after the tag's own), gives the block one parameter, and inserts a synthetic statement, `rebindParameters`, as the block's first step. That statement compiles to one runtime call over a declarative table of the function's parameters. The runtime resolves the record with the code a named-argument call already uses (`AgencyFunction.resolveNamed`, exposed as `bindRecord`), applies defaults, writes the frame, runs the `!` checks, and halts the block's runner on any failure so `block()` returns a failure value. A decorated function stores its parameters on first entry only, so a resume does not overwrite the rebind. The ordering rule "no required parameter after a defaulted one" is relaxed for the two decorator slots through one shared helper.

**Tech Stack:** TypeScript, vitest, the tarsec parser, the `TsNode` IR and mustache templates in `lib/backends/` and `lib/templates/`, Agency execution tests under `tests/agency/`.

**Spec:** `docs/superpowers/specs/2026-10-23-decorator-shape-and-arguments.md`. Review of the first draft of this plan: `2026-10-24-decorator-shape-and-arguments-REVIEW.md`, with the response at its end.

## Background for someone new to this code

Read `docs/dev/language/decorators.md` first. Then:

- A tag `@logged("x")` above `def add(a, b)` is rewritten, before type checking and before code generation, into `return logged("x", ...) { <body> }`. The rewrite is `lib/preprocessors/decoratorDesugar.ts`, run from the `TypeChecker` constructor and from `TypescriptPreprocessor.preprocess()`, so it is idempotent and mutates the def in place.
- A block argument compiles to its own `AgencyFunction` (`processBlockArgument`, `lib/backends/typescriptBuilder.ts:1915`; template `lib/templates/backends/typescriptGenerator/blockSetup.mustache`). Inside a block, the block's own parameters live on `__bstack.args`; the enclosing function's parameters are reached lexically through `__stack`. `x = 10` inside a block, where `x` is a parameter of the enclosing function, compiles to `__stack.args.x = 10`.
- On entry a function stores each parameter on its frame: `paramStore` (`typescriptBuilder.ts:2240`) emits `__stack.args["x"] = x === __UNSET ? <default> : x` on every entry. A `!` parameter uses `checkedParamStore` instead, which skips the store when the slot already exists, because a resume re-enters the function with the caller's original arguments and must not overwrite the checked value. Step 0 then runs `__checkParams` (`lib/runtime/paramChecks.ts:68`), which halts the runner with a failure when a check fails.
- Statements in a block body get their own step counter (`docs/dev/runtime/interrupts.md`). A resume skips completed steps. Once a runner is halted, every later `runner.step` returns without running (`Runner.shouldSkip`, `lib/runtime/runner.ts:313`), and the block returns `runner.haltResult`.
- `AgencyFunction.resolveNamed` (`lib/runtime/agencyFunction.ts:503`) is the one place that turns named arguments into a positional list: it rejects unknown names with a list of valid ones, throws `Missing required argument` for an absent required one, pads absent defaulted ones with `UNSET`, binds a trailing block to the last non-variadic parameter, and `resolvePositional` gathers a variadic (`[]` when absent). The compile-time twin is `lib/backends/typescriptBuilder/namedArgsResolver.ts`.
- "No required parameter after a defaulted one" is enforced twice: the parser refuses it on a `def` (`lib/parsers/parsers.ts:7524`), and the checker's `checkParamDefaultOrder` (`lib/typeChecker/paramDefaultOrder.ts`) reports AG6039. Both must learn the exemption.
- A synthetic statement node already exists as a model: `markDestructiveRan` (`lib/types/markDestructiveRan.ts`). A node type is registered in `lib/types.ts`, `lib/utils/identifierSlots.ts`, `lib/utils/bodySlots.ts`, `lib/utils/topLevel.ts`, and `processNode` in the builder.
- The generated import list is a template, `lib/templates/backends/typescriptGenerator/imports.mustache`. Edit the `.mustache` and run `pnpm run templates`; never the generated `.ts`. Every compiled fixture under `tests/typescriptGenerator/` prints that list, so a new import changes every `.mjs` there.
- The stdlib `guard` decorator is `stdlib/strategy.agency:201`. Seventeen agent files under `stdlib/agents/` import it and tag one def each; `tests/agency/guards/guard-decorator.agency` uses it fourteen times.

## Global Constraints

- Work in a worktree inside `packages/agency-lang/` (`worktree-decorator-shape`).
- Commit messages and PR bodies go in a file (`git commit -F`, `gh pr create --body-file`). Never on the command line.
- After every TypeScript edit, `pnpm run typecheck`. After every stdlib `.agency` edit, `make`. After every `.mustache` edit, `pnpm run templates`.
- Save every test run's output to a file under the scratchpad (`$SCRATCH`) and read the file.
- Do not run the full `tests/agency` suite locally. Run the `.agency` tests each task names with `pnpm run agency test <file>`.
- Every commit must build: `make` passes after each task's commit.
- No dynamic imports. Objects, not maps. Arrays, not sets. `type`, not `interface`. Never force push or amend.
- Prose follows `docs/dev/contributing/general-writing-tips.md`; check against `verbal-tics.md` before committing.
- The block parameter the lowering adds is named `__args`. The `__` check is in the parser and sees only user text, so a compiler-added name is allowed.
- Error text comes from `resolveNamed`; no task writes its own copy of `Missing required argument` or `Unknown named argument`.
- `docs/site/guide/decorators.md` and `guards.md` are edited in Task 7, in their own commit (owner said yes, 2026-10-24). No other `docs/site` page is hand-edited; the stdlib pages regenerate through `make`.

## Review Focus

Inputs the spec implies that are most likely to bite, each pinned by a test in the task named.

1. A real pause and resume inside a rebound body (`interruptHandlers` in the test file, no `handle` in the program). Expected: the body sees the rebound value after resume, and in a stack the inner decorator's `call.args` after resume equals what it saw before. (Task 5, `rebind-resumes`, `stacked-rebind-resumes`.)
2. A failing rebind on a function that does *not* return `Result`. Expected: `block()` returns a failure value the decorator can inspect with `isFailure`; nothing is thrown through the decorator. Three causes: missing required key, unknown key, failed `!` check. (Task 5, `rebind-failure-is-block-result`.)
3. `block()` on a function with a variadic parameter. Expected: the variadic is `[]`, as on a call that passes nothing. (Task 3 unit test; Task 5, `rebind-variadic`.)
4. A record that is not an object (`block(5)`). Expected: a failure naming the function. (Task 3 unit test.)
5. A decorator with the wrong shape. Expected: exactly one error, the shape error; no second "Unknown named argument 'call'" from the checker. (Task 4, `decoratorChecks.test.ts`.)

---

### Task 1: The decorator shape test

**Files:**
- Modify: `lib/types/function.ts` (beside `lastParameterTakesBlock`, line 36)
- Test: `lib/types/function.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** True when the last two parameters are `call` and a block taker, as every decorator's are. Ignores defaults. */
  export function hasDecoratorShape(parameters: FunctionParameter[]): boolean
  /** The clause after "'d' cannot decorate 'f': " when `parameters` is not a decorator's, or null. */
  export function decoratorShapeProblem(parameters: FunctionParameter[]): string | null
  /** The parameters a caller supplies: all of them, or all but the trailing `call` and block the compiler supplies on a decorator. */
  export function callerSuppliedParameters(parameters: FunctionParameter[]): FunctionParameter[]
  ```
  `hasDecoratorShape` is `parameters.length >= 2 && parameters[length-2].name === "call" && lastParameterTakesBlock(parameters)`. The owner chose (2026-10-24) to keep accepting an untyped or `any` last parameter as the block, so `lastParameterTakesBlock` stays. `callerSuppliedParameters` is `hasDecoratorShape(p) ? p.slice(0, -2) : p`.

  The three clauses:
  - Fewer than two parameters, or the last cannot take a block: ``a decorator receives the body of the function it decorates as a block, so its last parameter must be a block, such as `block: (args: object) -> any`.``
  - Second-to-last not named `call`: ``a decorator's last two parameters are `call: Call` and a block, so `call` must come right before the block. Found '<name>' there.``
  - `call` or the block has a default: ``'<name>' has a default, but a decorator always receives `call` and the block. Remove the default.``

- [ ] **Step 1: Write the failing tests** in `lib/types/function.test.ts`

```ts
describe("decorator shape", () => {
  const param = (name: string, extra: Partial<FunctionParameter> = {}): FunctionParameter =>
    ({ name, ...extra }) as FunctionParameter;
  const block = param("block", { typeHint: BLOCK_HINT });   // build BLOCK_HINT the way the file builds other hints

  it("accepts your args, then call, then a block", () => {
    const params = [param("cost"), param("call"), block];
    expect(hasDecoratorShape(params)).toBe(true);
    expect(decoratorShapeProblem(params)).toBeNull();
    expect(callerSuppliedParameters(params)).toEqual([param("cost")]);
  });
  it("refuses a def with no block", () => {
    expect(decoratorShapeProblem([param("call"), param("x", { typeHint: STRING_HINT })]))
      .toContain("its last parameter must be a block");
  });
  it("refuses call in the wrong slot", () => {
    const params = [param("call"), param("tag"), block];
    expect(decoratorShapeProblem(params)).toContain("Found 'tag' there");
    expect(hasDecoratorShape(params)).toBe(false);
    expect(callerSuppliedParameters(params)).toEqual(params);
  });
  it("refuses a default on call or the block", () => {
    expect(decoratorShapeProblem([param("call", { defaultValue: NULL_LITERAL }), block])).toContain("'call' has a default");
    expect(decoratorShapeProblem([param("call"), { ...block, defaultValue: NULL_LITERAL }])).toContain("'block' has a default");
  });
});
```

- [ ] **Step 2: Run to see them fail.** `pnpm vitest run lib/types/function.test.ts > $SCRATCH/t1.txt 2>&1; tail -20 $SCRATCH/t1.txt`
- [ ] **Step 3: Implement the three functions** after `lastParameterTakesBlock`.
- [ ] **Step 4: Run to see them pass**, then `pnpm run typecheck`.
- [ ] **Step 5: Commit** (`feat(decorators): one function decides the decorator shape`).

---

### Task 2: Relax the parameter-ordering rule for the two decorator slots

**Files:**
- Modify: `lib/parsers/parsers.ts:7524-7540`; `lib/typeChecker/paramDefaultOrder.ts:15-30`
- Test: `lib/typeChecker/paramDefaultOrder.test.ts`

**Interfaces:** consumes `callerSuppliedParameters` (Task 1).

- [ ] **Step 1: Write the failing tests**

```ts
it("allows defaulted parameters before `call` and the block on a decorator", () => {
  expect(orderError('def d(cost: number = 1, call: Call, block: () -> any) { return block() }')).toBeUndefined();
});
it("still refuses a required parameter after a defaulted one when the shape is not a decorator's", () => {
  expect(() => typeCheckSource('def d(cost: number = 1, label: string, block: () -> any) { return block() }')).toThrow();
});
it("still refuses it on a node", () => {
  expect(orderError('node t(a: string = "x", call: string, b: string) { return b }')).toBeDefined();
});
```

The first fails today in the parser. For the second, run once and tighten `toThrow()` to the message the parser actually prints (the `label(...)` wrapper may replace the specific message, as the neighbouring test at line 15 shows).

- [ ] **Step 2: Run to see the first fail.** `pnpm vitest run lib/typeChecker/paramDefaultOrder.test.ts > $SCRATCH/t2.txt 2>&1`
- [ ] **Step 3: Parser.** Run the default-order check over `callerSuppliedParameters(params)`; keep the variadic check over the full list.
- [ ] **Step 4: Checker.** In `checkParamDefaultOrder`, for a `function` node, loop over `callerSuppliedParameters(node.parameters)`. Nodes unchanged.
- [ ] **Step 5: Run the file and `pnpm vitest run lib/parsers > $SCRATCH/t2b.txt 2>&1`.** Green. `pnpm run typecheck`.
- [ ] **Step 6: Commit** (`feat(decorators): defaults may precede call and the block`).

---

### Task 3: `bindRecord`, the `rebindParameters` statement, and its codegen

Generated code says *what* (a table of the function's parameters); the runtime says *how*, and the "how" of resolving a record is the code a call already uses.

**Files:**
- Modify: `lib/runtime/agencyFunction.ts` (new public method beside `partial`)
- Create: `lib/runtime/rebind.ts`, `lib/runtime/rebind.test.ts`
- Create: `lib/types/rebindParameters.ts`
- Modify: `lib/types.ts`, `lib/utils/identifierSlots.ts:214`, `lib/utils/bodySlots.ts:193`, `lib/utils/topLevel.ts:99`
- Modify: `lib/backends/typescriptBuilder.ts` (`processNode` case at 685; `processRebindParameters`; `buildFunctionBody` at 2337 and its caller at 2560; `checkedParamStore` at 2226)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache:32`, then `pnpm run templates`
- Test: `lib/runtime/agencyFunction.test.ts` (or the file that tests `.partial()`), `lib/runtime/rebind.test.ts`. Codegen is tested through the fixture in Task 4.

**Interfaces:**
- Produces, on `AgencyFunction`:
  ```ts
  /** The value of every unbound parameter for a call that passes `record`
   *  by name and nothing by position: the record's value, UNSET for an
   *  absent defaulted parameter, [] for an absent variadic. `blockArg` is
   *  the value of the block-typed parameter, if the function has one, since
   *  a record cannot carry it. Throws the messages a call throws: unknown
   *  name, missing required argument. A null or undefined record is empty;
   *  any other non-object throws `block() in '<name>' takes a record of
   *  arguments, got <JSON>`. */
  bindRecord(record: unknown, blockArg?: unknown): Record<string, unknown>
  ```
  Implementation: `this.resolveNamed([], { ...record }, blockArg)`, then zip the positional result with `this._unboundParams` names. The module-level constant for a def is never partially applied, so `_unboundParams` is all of its parameters; say so in the comment.
- Produces, in `lib/runtime/rebind.ts`:
  ```ts
  export type RebindSpec = {
    name: string;
    checked: boolean;               // written `name: T!`
    defaultValue?: () => unknown;   // a thunk: the default is an Agency expression compiled in the function's scope
  };
  /** The rebind statement. Binds `record` with `fn.bindRecord`, stores each
   *  spec entry on `frame.args` (calling `defaultValue` when the bound value
   *  is UNSET), then runs `__checkParams` over the checked entries when
   *  there are any. Any thrown error from binding becomes
   *  `runner.halt(failure(message))`, so the block returns a failure and
   *  nothing propagates through the decorator. */
  export async function __rebindParameters(
    run: Run, runner: HaltingRunner, frame: ArgFrame, fn: AgencyFunction,
    record: unknown, blockArg: unknown, spec: RebindSpec[], checks: ParamChecks | null,
  ): Promise<void>
  ```
- Produces, `lib/types/rebindParameters.ts`:
  ```ts
  /** Synthetic first statement of a decorated body's block. Compiles to one
   *  `__rebindParameters` call. Declares no identifiers of its own in
   *  identifierSlots on purpose: it writes the enclosing function's
   *  parameters and reads `__args`, and no walker needs that today. */
  export type RebindParameters = BaseNode & {
    type: "rebindParameters";
    functionName: string;             // the decorated def; also the name of its module-level constant
    parameters: FunctionParameter[];  // the def's non-block parameters, in order
    blockParameter: string | null;    // the def's block-typed parameter, if any
    record: string;                   // the block parameter holding the record: "__args"
  };
  ```
- Codegen, one statement pair from `processRebindParameters`:
  ```ts
  await __rebindParameters(__run, runner, __stack, f, __bstack.args["__args"], __stack.args["body"] /* or undefined */, [
    { name: "a", checked: false },
    { name: "b", checked: true, defaultValue: () => (<default expression of b>) },
  ], __f_paramChecks /* or null */);
  if (runner.halted) return;
  ```
  `f` is `ts.id(node.functionName)`, the constant `__AgencyFunction.create` assigns (see `processFunctionDefinition`, 2518). Each default is `this.processNode(param.defaultValue)`. `checked` is `isCheckedParam(param)`; the table is `this.paramChecksName(functionName)` when any parameter is checked, else `null`.
- `buildFunctionBody` gains `storeOnFirstEntry: boolean`; when true every parameter uses the skip-if-slot-exists store (today's `checkedParamStore`, renamed `firstEntryParamStore`). `processFunctionDefinition` passes `(node.decorators ?? []).length > 0`. This is what lets a resume keep the rebound values.

- [ ] **Step 1: `bindRecord` tests**, next to the `.partial()` tests. Build a function with `AgencyFunction.create` over `def f(a, b = "d", ...rest)`-shaped params (`hasDefault`, `variadic` flags as the fixtures show).

```ts
it("binds present keys, UNSET for an absent default, [] for an absent variadic", () => {
  expect(fn.bindRecord({ a: 1 })).toEqual({ a: 1, b: UNSET, rest: [] });
});
it("treats null as the empty record", () => expect(fn.bindRecord(null)).toMatchObject({ b: UNSET }) /* a is required: see next */);
it("throws the call's message for a missing required key", () =>
  expect(() => fn.bindRecord({})).toThrow("Missing required argument 'a' in call to 'f'"));
it("throws the call's message for an unknown key", () =>
  expect(() => fn.bindRecord({ a: 1, c: 2 })).toThrow("Unknown named argument 'c' in call to 'f'"));
it("refuses a record that is not an object", () =>
  expect(() => fn.bindRecord(5)).toThrow("block() in 'f' takes a record of arguments, got 5"));
it("passes the block argument to the block parameter", () => {
  expect(withBlock.bindRecord({ n: 1 }, theBlock)).toEqual({ n: 1, body: theBlock });
});
```

Fix the "null" test to a function whose parameters all have defaults.

- [ ] **Step 2: `__rebindParameters` tests** in `rebind.test.ts`. Frame `{ args: {} }`, a runner stub recording `halt`, a `checks` table rejecting negatives (see `paramChecks.test.ts`).

```ts
it("stores bound values and calls the default thunk for UNSET", ...)       // frame.args == { a: 1, b: "dflt" }
it("halts the runner with the bind failure instead of throwing", ...)      // record { c: 1 }: runner.halted, haltResult.error contains "Unknown named argument 'c'"
it("halts on a missing required key", ...)
it("runs the ! checks and halts on a failed one", ...)                    // { n: -1 } with checked n
it("leaves the frame untouched when binding fails", ...)
```

- [ ] **Step 3: Run both files to see them fail.** `pnpm vitest run lib/runtime/rebind.test.ts lib/runtime/agencyFunction.test.ts > $SCRATCH/t3.txt 2>&1`
- [ ] **Step 4: Implement `bindRecord` and `rebind.ts`.** Export `__rebindParameters` and `RebindSpec` from where `__checkParams` is exported for generated code; add `__rebindParameters` to `imports.mustache` beside `__checkParams`; `pnpm run templates`.
- [ ] **Step 5: Run to see them pass.**
- [ ] **Step 6: Add the node type** and its four registrations. `pnpm run typecheck`; give any exhaustive switch a leaf case.
- [ ] **Step 7: Codegen.** `processNode` case; `processRebindParameters`; the `storeOnFirstEntry` option and the rename of `checkedParamStore`. Update the comment at 2226-2232 to say the first-entry store now also covers every parameter of a decorated function and why.
- [ ] **Step 8: `pnpm run typecheck && pnpm run lint:structure > $SCRATCH/t3b.txt 2>&1`.** Follow any linter message about the new import.
- [ ] **Step 9: Commit** (`feat(decorators): rebindParameters over AgencyFunction.bindRecord`). (`make` still passes: nothing emits the node yet.)

---

### Task 4: The lowering, the checker, and the stdlib signature

This commit changes what a decorator is, so everything that *is* one changes with it: the stdlib `guard` decorator's signature (not its name; that is Task 6) and the codegen fixture. Otherwise `make` fails between tasks.

**Files:**
- Modify: `lib/preprocessors/decoratorDesugar.ts`; `lib/types/function.ts:142` (`DecoratorOrigin`); `lib/typeChecker/checker.ts:729-743` and the call-check entry that runs `checkNamedArgStructure`/`checkArity` on a call with `call.decorator`; `lib/typeChecker/diagnosticExplanations.ts` (the unknown-decorator wording and the `decoratorBodyReturn` example at 816)
- Modify: `stdlib/strategy.agency:201-230` (signature only: `call` moves to second-to-last, the block loses `= null`, the guard block becomes `return block(call.args)`); `stdlib/index.agency:71-74` (the `Call` doc comment)
- Modify: `tests/typescriptGenerator/decorators.agency` (`retry` gains `call: Call` before its block)
- Test: `lib/preprocessors/decoratorDesugar.test.ts`, `lib/typeChecker/decoratorChecks.test.ts`, `lib/typeChecker/mismatch.test.ts:14`

**Interfaces:**
- Consumes: `decoratorShapeProblem`, `callerSuppliedParameters`, `hasDecoratorShape` (Task 1); `RebindParameters` (Task 3).
- Produces the lowered shape:
  ```
  return <decorator>(<tag arguments as written>, call: { name: "<def>", args: { a: a, b: b } }) {
    <rebindParameters functionName="<def>" parameters=[a, b] blockParameter=null record="__args">
    <original body>
  }
  ```
  `call.block = { type: "blockArgument", inline: false, params: [{ name: "__args" }], body }`. The innermost block reuses the def's body array: `unshift` the rebind, do not copy. Each outer block of a stack also starts with a rebind.

- [ ] **Step 1: Update the desugar tests**: named `call` last in `arguments`, tag arguments before it in order; `block.params` is `[{ name: "__args" }]`; `block.body[0]` is the `rebindParameters` node with the def's non-block parameters and `blockParameter` set when the def takes a block; drop the `passesCallRecord` expectations (lines 87, 95); add a problem test per clause (`Found 'tag' there`, `'block' has a default`, `its last parameter must be a block`); change the unknown-decorator text to ``A decorator is a def whose last two parameters are `call: Call` and a block; declare or import '...'``.
- [ ] **Step 2: Run to see them fail.** `pnpm vitest run lib/preprocessors/decoratorDesugar.test.ts > $SCRATCH/t4.txt 2>&1`
- [ ] **Step 3: Rewrite `decoratorCall`** and the header comment. `decoratorLookup`'s `parameters` are now used only by `decoratorProblems`.
- [ ] **Step 4: `problemWithTag`**: replace the `lastParameterTakesBlock` check with `decoratorShapeProblem(signature.parameters)` prefixed `'${decorator}' cannot decorate '${target}': `.
- [ ] **Step 5: Checker.** `writableParameterNames` → `callerSuppliedParameters(params).map(p => p.name)`; `hiddenDecoratorArguments(call, params)` → `params.length - callerSuppliedParameters(params).length`. When `call.decorator` is set and `!hasDecoratorShape(params)`, skip the call's argument checks entirely (the shape error already covers it). Remove `passesCallRecord` from `DecoratorOrigin` and `mismatch.test.ts`. `pnpm run typecheck`.
- [ ] **Step 6: `decoratorChecks.test.ts`.** `BUDGETED` becomes `def budgeted(cost: number, call: Call, block: () -> string): Result<string>`. Add:

```ts
it("accepts block(call.args) against a block typed () -> any", () => {
  const src = "def d(call: Call, block: () -> any): any { return block(call.args) }\n@d\ndef f(a: number): number { return a }\n";
  expect(typecheckSource(src).errors).toEqual([]);
});
it("reports a wrong-shape decorator once", () => {
  const src = "def d(call: Call, tag: string, block: () -> any): any { return block() }\n@d(\"t\")\ndef f(): string { return \"a\" }\n";
  const result = prepareProgram-or-typecheck(src);       // whichever the file already uses to see decorator-stage errors
  expect(result.errors.filter((e) => /call/.test(e.message))).toHaveLength(1);
  expect(result.errors[0].message).toContain("Found 'tag' there");
});
```

- [ ] **Step 7: Explanations.** `diagnosticExplanations.ts:816`: the example becomes `def budgeted(cost: number, call: Call, block: () -> string): Result<string>`. Any "last parameter is a block" sentence becomes the two-parameter wording.
- [ ] **Step 8: Stdlib signature.** `strategy.agency`: `export def guard(cost: number | null = null, time: number | null = null, label: string | null = null, call: Call, block: (args: object) -> any): Result raises <std::guard>`; body `return block(call.args)` inside the guard block. `stdlib/index.agency`: the `Call` comment says "the second-to-last parameter of every decorator". `make > $SCRATCH/t4b.txt 2>&1`; read the tail.
- [ ] **Step 9: Checker tests.** `pnpm vitest run lib/typeChecker lib/preprocessors > $SCRATCH/t4c.txt 2>&1`. Green.
- [ ] **Step 10: Fixtures.** Edit `tests/typescriptGenerator/decorators.agency` first (`retry` gains `call: Call`), then `make fixtures > $SCRATCH/t4d.txt 2>&1`. Every `.mjs` changes by the one import line; `decorators.mjs` also shows `call:` as a named argument and `await __rebindParameters(` as the block's first step. `git diff --stat tests/typescriptGenerator/` and spot-check two unrelated `.mjs` files for the import line only.
- [ ] **Step 11: Commit** (`feat(decorators): call by name after the tag's arguments; the block takes the record`).

---

### Task 5: Migrate the Agency fixtures and add the new ones

**Files:**
- Modify, under `tests/agency/decorators/`: `retry-calls-block-twice`, `stacked-order`, `handler-in-decorator`, `interrupt-resumes`, `log-around`, `match-in-body`, `guard-in-decorated-body`, `destructive-region-in-body`, `finalize-in-body`, `decorated-block-taker`, `through-record-field`, `call-record`, `local-call-type`; `compile-errors/no-block-parameter` (new wording)
- Modify: `tests/agency-js/decorator-handoff/agent.agency`; `tests/agency/guards/guard-decorator.agency` (the stdlib signature changed in Task 4: nothing to edit unless a test there calls `guard` as a function; run it)
- Create, under `tests/agency/decorators/`: `rebind-changes-argument`, `rebind-no-arguments`, `rebind-missing-required`, `rebind-restores-original`, `rebind-rechecks-validated`, `rebind-unknown-key`, `rebind-alias-key`, `rebind-keeps-block-parameter`, `rebind-resumes`, `stacked-rebind-resumes`, `rebind-failure-is-block-result`, `rebind-variadic`, `stacked-rebind-order`, `defaults-before-call`
- Create, under `compile-errors/`: `call-not-second-to-last`, `default-on-call-or-block`

Each new fixture is an `.agency` plus a `.test.json` in the format of `call-record.test.json`, `"evaluationCriteria": [{ "type": "exact" }]`.

- [ ] **Step 1: Migrate.** Decorators gain `call: Call` before the block where missing; `block()` becomes `block(call.args)` where the body reads a parameter. Run each: `pnpm run agency test tests/agency/decorators/<name>.agency > $SCRATCH/t5-<name>.txt 2>&1`. The handoff one: `pnpm run agency test js tests/agency-js/decorator-handoff/`. The guard one: `pnpm run agency test tests/agency/guards/guard-decorator.agency`.

- [ ] **Step 2: Write the new fixtures.**

`rebind-changes-argument`:
```
def withDefaultName(call: Call, block: (args: object) -> any): any {
  return block({ ...call.args, name: "default" })
}
@withDefaultName
def greet(name: string): string { return "hello ${name}" }
node main() { return greet("ignored") }          // "hello default"
```

`rebind-no-arguments`: decorator calls `block()`; `def f(a: number = 5, b: string = "x"): string { return "${a}:${b}" }`; `main` returns `f(1, "y")`; expects `"5:x"`.

`rebind-missing-required`: same decorator; `def f(a: number): Result<number> { return success(a) }`; `main`: `const r = f(1)` then `return isFailure(r) ? r.error : "unexpected"`; expects `Missing required argument 'a' in call to 'f'`.

`rebind-restores-original`: decorator runs `block({ ...call.args, n: 100 })` then returns `block(call.args)`; `def f(n: number): number { return n }`; `f(7)` expects `7`.

`rebind-rechecks-validated`: a `@validate` type rejecting `<= 0` (pattern from `tests/agency/validator-predicates.agency`); decorator calls `block({ n: -1 })`; `def f(n: Positive!): Result<number>` whose body is `print("ran")` then `return success(n)`; `main` returns `isFailure(r)`; expects `true` and output not containing `ran`.

`rebind-unknown-key`: `block({ ...call.args, bogus: 1 })`; `def f(a: number): Result<number>`; expects the error starting `Unknown named argument 'bogus' in call to 'f'.` (copy the valid-names sentence from one run).

`rebind-alias-key`: `def fetch(baseUrl | url: string): Result<string>` under a decorator calling `block({ url: "x" })`; expects the unknown-key error for `url` (an alias is for callers that guessed, not for Agency code: `parameter-aliases.md`).

`rebind-keeps-block-parameter`: `def f(n: number, body: () -> number): number { return n + body() }` under `block({ n: 10 })`; `f(1) { return 5 }` expects `15`.

`rebind-resumes`: decorator calls `block({ ...call.args, n: 2 })`; body `interrupt("go?")` then `return n`; `main` calls `f(1)` with NO handler; `.test.json` has `"interruptHandlers": [{ "action": "approve" }]` (as `interrupt-resumes.test.json`); expects `2`. This is the real pause-and-resume the review asked for.

`stacked-rebind-resumes`: `@outer @inner def f(n: number)`; `outer` calls `block({ n: 2 })`; `inner` records `call.args.n` into a global list, then `block(call.args)`; body interrupts then returns `n`; `interruptHandlers` approve; `main` returns `[f(1), seen]`; expects `[2, [2, 2]]` (inner's record is rebuilt on resume from the preserved slots, so it sees `2` both times).

`rebind-failure-is-block-result`:
```
let seen: string[] = []
def inspecting(record: object, call: Call, block: (args: object) -> any): string {
  const r = block(record)
  if (isFailure(r)) { seen = [...seen, "failure"]; return "handled" }
  return "ran"
}
@inspecting({})                      // missing required
def missing(a: number): string { return "body" }
@inspecting({ a: 1, bogus: 2 })      // unknown key
def unknown(a: number): string { return "body" }
@inspecting({ n: -1 })               // failed ! check
def checked(n: Positive!): string { return "body" }
node main() { return [missing(1), unknown(1), checked(3), seen] }   // ["handled","handled","handled",["failure","failure","failure"]]
```
None of the decorated functions returns `Result`, so a thrown error could not be laundered into a failure by the function's own catch.

`rebind-variadic`: `def f(first: string = "a", ...rest: string[]): string { return "${first}|${rest.join(",")}" }`; one decorator calls `block({ ...call.args, rest: ["x"] })`, a second calls `block()`; `main` returns both; expects `["a|x", "a|"]`.

`stacked-rebind-order`:
```
let seen: number[] = []
def outer(call: Call, block: (args: object) -> any): any { return block({ n: 2 }) }
def inner(limit: number, call: Call, block: (args: object) -> any): any {
  seen = [...seen, limit, call.args.n]
  return block(call.args)
}
@outer
@inner(limit: n)
def f(n: number): number { return n }
node main() { f(1); return seen }              // [2, 2]
```

`defaults-before-call`: `def tagged(label: string = "none", call: Call, block: (args: object) -> any): string { return "${label}:${block(call.args)}" }`; `@tagged` on one def, `@tagged("x")` on another; `main` returns both; `["none:a", "x:b"]`.

`compile-errors/call-not-second-to-last.agency`: `def logged(call: Call, tag: string, block: () -> any): any { return block() }` with `@logged("t")` on a def; `"expectedCompileError": "Found 'tag' there"`.

`compile-errors/default-on-call-or-block.agency`: `def d(call: Call, block: () -> any = null)`; `"expectedCompileError": "'block' has a default"`.

- [ ] **Step 3: Run each new test**, one output file per test. Green.
- [ ] **Step 4: Commit** (`test(decorators): fixtures for the new shape and the rebind rules`).

---

### Task 6: Rename `@guard` to `@guarded`

**Files:**
- Modify: `stdlib/strategy.agency` (the def's name and doc comment, and the module-doc example above it); the 17 files under `stdlib/agents/` (`grep -rln "@guard(" stdlib/agents`); `tests/agency/guards/guard-decorator.agency`; `lib/parsers/parsers.ts:249` (comment)
- Regenerate: `docs/site/stdlib/**` through `make`

- [ ] **Step 1:** Rename the def and update its doc comment.
- [ ] **Step 2:** `@guard(` → `@guarded(` and `import { guard }` → `import { guarded }` (also the `{ Critique, guard, revise }` form). Check the diff by eye for any `guard(` that is the block and must stay.
- [ ] **Step 3:** `make > $SCRATCH/t6.txt 2>&1`. `git diff --stat docs/site` shows only pages that print `@guarded`.
- [ ] **Step 4:** `pnpm run agency test tests/agency/guards/guard-decorator.agency > $SCRATCH/t6b.txt 2>&1`. Green.
- [ ] **Step 5: Commit** (`refactor(stdlib): rename the guard decorator to guarded`).

---

### Task 7: Docs and the example file

**Files:**
- Modify: `docs/dev/language/decorators.md` (definition and rule 1; "The `call` record"; the "Counts on a tag" paragraph at line 168 that describes `passesCallRecord`; the `@guard` section; Files), `docs/dev/agents/subagent-budgets.md`, `CLAUDE.md` and `.claude/skills/agency-language-docs/` (the `decorators.md` index line)
- Modify, in a separate commit: `docs/site/guide/decorators.md`, `docs/site/guide/guards.md` (owner said yes, 2026-10-24)
- Modify: `dec.agency`

- [ ] **Step 1: Dev doc.** New shape; record by name after the tag's arguments; the block takes a record and the rebind statement (what it reuses: `bindRecord`, the defaults, `__checkParams`; failures halt the block's runner); the three call forms; stacking rebinds in turn; the first-entry store for decorated functions and why (the resume problem from the review); "Counts on a tag" without `passesCallRecord`; the rename in place of the "cannot be called with a block" section, keeping the "never printed as text" paragraph; Files updated; the layout decision and the two alternatives set aside, in two sentences.
- [ ] **Step 2: `subagent-budgets.md`.** `@guard` → `@guarded`; drop "cannot call the decorator inline"; keep the inner-def explanation.
- [ ] **Step 3: Index lines** in `CLAUDE.md` and the skill: add "the fixed shape (your arguments, `call`, the block), `block(record)` and the rebind statement, the first-entry store a decorated def uses, and the `@guarded` rename".
- [ ] **Step 4: `dec.agency`.** New shape; `logged` takes `tag: string` first; add `withDefaultName` showing a rebind. Run `pnpm run agency dec.agency > $SCRATCH/t7.txt 2>&1`; paste the output into a comment at the bottom.
- [ ] **Step 5: Verbal-tics pass** on every changed doc. Commit (`docs(decorators): the fixed shape, block(record), and @guarded`).
- [ ] **Step 6: Guide pages**, own commit. `decorators.md`: new shape in every example; "Passing arguments" shows tag arguments landing on the first parameters; "The `call` record" says it is always present, comes right before the block, and is passed by name, so a direct call to a decorator must write `call:` too (no checker warning for this, by the owner's choice); new section "Changing the arguments" with the three forms and the failure rule; "Mistakes and what they say" lists the two new messages. `guards.md`: `@guarded`.

---

### Task 8: Whole-branch checks and the PR

- [ ] **Step 1:** `pnpm run typecheck && pnpm run lint:structure && pnpm run fmt:ts`, each to a file; commit any formatting change.
- [ ] **Step 2:** `pnpm vitest run lib/types lib/preprocessors lib/typeChecker lib/runtime lib/parsers > $SCRATCH/t8.txt 2>&1`; read the tail. Green.
- [ ] **Step 3:** Audit the diff against `docs/dev/contributing/anti-patterns.md`.
- [ ] **Step 4:** Push; `gh pr create --body-file $SCRATCH/pr.md`. Body: three bullets (shape, `block(record)`, rename), the spec path, the migration note (add `call: Call` before the block; `@guard` → `@guarded`), the attribution line from the session reminder. Then stop; the owner merges.

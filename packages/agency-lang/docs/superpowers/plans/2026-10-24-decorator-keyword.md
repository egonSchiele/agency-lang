# The `decorator` keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A def is a decorator because it says `decorator def`, not because its second-to-last parameter is named `call`.

**Architecture:** `decorator` becomes a fourth function marker, carried in `markers.decorator` through the parser, the symbol table, imports, and re-exports exactly as `handoff` is. One section of `lib/types/function.ts` owns everything the compiler knows about a decorator's parameter list: whether a def is a decorator, which slot is the record, the filled-in types, the shape check, and which parameters a caller writes. Every other file asks those functions and never reads `markers` or counts slots itself. The two new error messages live in the diagnostic registry only; the decorator stage and the checker both render from it.

**Tech Stack:** TypeScript, tarsec parsers, vitest, the Agency test runner (`pnpm run agency test <file>`).

**Spec:** `docs/superpowers/specs/2026-10-24-decorator-keyword.md`. Revised after `2026-10-24-decorator-keyword-REVIEW.md`.

## Background for someone new to this code

A decorator in Agency is a function that receives another function's body as a block:

```
decorator def logged(tag: string, call, block) {
  print("${tag}: entering ${call.name}")
  return block(call.args)
}

@logged("adit")
def add(a: number, b: number): number {
  return a + b
}
```

The compiler rewrites `add` so its body becomes a call to `logged("adit", call: { name: "add", args: { a: a, b: b } }) { ...the body... }`. That rewrite is the "lowering" in `lib/preprocessors/decoratorDesugar.ts`, and it runs in two places: the type checker's constructor and `TypescriptPreprocessor.preprocess()`. Before the lowering, `decoratorProblems` in the same file lists every mistake in a program's decorators; `prepareProgram` and the CLI build turn that list into compile errors, which matters because the type checker is off by default.

Today the compiler decides a def is a decorator by looking at its parameters: the second-to-last is named `call` and the last takes a block. `hasDecoratorShape` in `lib/types/function.ts` is that test, and `callerSuppliedParameters` uses it to leave the last two parameters out of two checks (a required parameter may not follow an optional one; a decorator's call has two arguments the user did not write). This plan replaces the test with a keyword.

Function markers are the mechanism to copy. `FUNCTION_MARKER_KEYWORDS` in `lib/types/function.ts` lists `destructive`, `idempotent`, and `handoff`. The parser accepts any of them before `def` in any order (`parseFunctionModifiers` in `lib/parsers/parsers.ts`), stores them as `def.markers`, the symbol table copies `markers` onto each function symbol (`lib/symbolTable.ts:470`), re-exports copy them onto the wrapper def (`lib/preprocessors/resolveReExports.ts:243`), the formatter prints them in list order before `def` (`lib/backends/agencyGenerator.ts:1294`), and codegen passes them to `AgencyFunction.create` (`lib/backends/typescriptBuilder.ts:2675`). Adding a marker is one word in the list plus one optional field on `FunctionMarkers` and on the runtime's `ToolMarkers`.

A type written in source parses to a `VariableType`. The named type `Call` is `{ type: "typeAliasVariable", aliasName: "Call" }` (`lib/types/typeHints.ts:312`); `variableTypeParser` in `lib/parsers/parsers.ts:2517` parses one from text, and `lib/parsers/typeHints.test.ts` shows how tests use it.

`docs/dev/language/decorators.md` is the dev doc for all of this. Read it first.

## Global Constraints

- Work on a branch off `origin/main`, never on the squash-merged `adit/decorator-shape`.
- Formatter print order: `destructive idempotent handoff decorator def`; `export` first.
- Diagnostic codes: AG6043 `decoratorShape`, message `'{name}' is declared as a decorator, but {problem}`, at the def for a local decorator and at the tag for an imported one; AG6044 `notADecorator`, message `'{name}' is not a decorator, so '@{name}' cannot go on '{target}'. Declare it as \`decorator def {name}(...)\`.`, at the tag. Both messages exist only in `lib/typeChecker/diagnostics.ts`.
- Implicit types: an untyped record slot is `Call`; an untyped block slot is `(args: object) -> any`. A written type is kept.
- A `decorator def` can be called directly; the call slot takes a record literal; it is never nullable.
- A plain def is never a decorator, whatever its parameters.
- Every task leaves `make`, `pnpm run typecheck`, and the decorator fixtures green.
- No dynamic imports, objects not maps, arrays not sets, types not interfaces, no raw `markers?.decorator` reads outside `lib/types/function.ts`. Commit messages go in a file.
- Run `pnpm run fmt:ts` and `pnpm run typecheck` before every commit. Save test output to a file in the scratchpad and read it from there.

## Review Focus

Inputs the spec implies that a user will hit first. Each has a test in the task named.

1. `export decorator def` and `decorator export def` both parse and print as `export decorator def` (Task 1).
2. A decorator whose two slots are named `ctx` and `body`, both untyped, works end to end: the record arrives under `ctx`, `ctx.name` type-checks, `body()` and `body(ctx.args)` run (Task 5).
3. A direct call `tagged("t", call: { name: "x", args: {} }) { ... }` runs, and a direct call that leaves the record out is an arity error (Task 5 and Task 4).
4. A decorator imported from another file, and one re-exported through a middle file, is accepted as a tag and runs; the re-export wrapper passes the block on positionally, which no fixture exercises today (Task 5).
5. `decorator def d(call: Call, tag: string, block)` is refused at the def with the "receives the call record" message, with the checker off, so the runtime trap from the previous spec stays closed (Task 3).

---

### Step 0: The worktree

```bash
cd packages/agency-lang
git fetch origin
git worktree add worktree-decorator-keyword -b adit/decorator-keyword origin/main
cd worktree-decorator-keyword && pnpm install --offline
```

Copy the spec, this plan, and the review from `worktree-decorator-shape` into the same paths. Commit them with the first task.

---

### Task 1: The marker, and every existing decorator says it

**Files:**
- Modify: `lib/types/function.ts:115-135` (`FUNCTION_MARKER_KEYWORDS`, `FunctionMarkers`); `lib/runtime/agencyFunction.ts:95-101` (`ToolMarkers.decorator`)
- Modify: `stdlib/strategy.agency:202`; every `.agency` under `tests/agency/decorators/`, `tests/typescriptGenerator/decorators.agency`, `tests/agency-js/decorator-handoff/agent.agency`; every `lib/**/*.test.ts` whose source text declares a decorator (`grep -rl "call: Call" lib --include=*.test.ts`: `decoratorDesugar.test.ts`, `effectsOracle.test.ts`, `lsp/diagnostics.test.ts`, `paramDefaultOrder.test.ts`, `prepareProgram.test.ts`, `decoratorChecks.test.ts`, `raisesDiagnostic.test.ts`)
- Test: `lib/parsers/function.test.ts` (next to "parses handoff def", line 2198); `lib/backends/agencyGenerator.test.ts` (next to "round-trips handoff defs, export first", line 1386)
- Regenerate: `make fixtures` (codegen prints the marker list into every decorator's `AgencyFunction.create`)

**Interfaces:**
- Produces: `FunctionMarkers.decorator?: boolean` and `ToolMarkers.decorator?: boolean`; `def.markers?.decorator` on every parsed `decorator def`.

Why the migration is here: after Task 2 the parser exempts the last two parameters from the required-after-optional check only for a `decorator def`. `guarded` in `stdlib/strategy.agency` has three defaulted parameters before `call`, so without the keyword the stdlib stops parsing and `make` fails. After this task the keyword is accepted and the old name-based detection still runs, so every source works with or without it, and each later task lands green.

- [ ] **Step 1: Write the failing parser tests**

```ts
it("parses decorator def", () => {
  const parsed = functionParser("decorator def logged(tag: string, call, block) { return block() }");
  expect(parsed.success).toBe(true);
  expect(parsed.result.markers).toEqual({ decorator: true });
  expect(parsed.result.parameters.map((p) => p.name)).toEqual(["tag", "call", "block"]);
});

it("parses export and decorator in either order", () => {
  for (const src of [
    "export decorator def d(call, block) { return block() }",
    "decorator export def d(call, block) { return block() }",
  ]) {
    const parsed = functionParser(src);
    expect(parsed.success).toBe(true);
    expect(parsed.result.exported).toBe(true);
    expect(parsed.result.markers).toEqual({ decorator: true });
  }
});
```

- [ ] **Step 2: Write the failing formatter test**

```ts
it("round-trips decorator defs, export first, decorator before def", () => {
  expect(roundTrip("decorator export def d(call, block) {\n  return block()\n}")).toContain(
    "export decorator def d(call, block)",
  );
  expect(roundTrip("handoff decorator def d(call, block) {\n  return block()\n}")).toContain(
    "handoff decorator def d",
  );
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `npx vitest run lib/parsers/function.test.ts lib/backends/agencyGenerator.test.ts > $SCRATCHPAD/t1.txt 2>&1; grep -E "Tests |×" $SCRATCHPAD/t1.txt`

- [ ] **Step 4: Add the marker**

Append `"decorator"` to `FUNCTION_MARKER_KEYWORDS` (last, so it prints right before `def`). Add to `FunctionMarkers`:

```ts
  /** Declared `decorator def`: its last two parameters receive a call
   *  record and the decorated body as a block, and only such a def may be
   *  named in a tag. See docs/dev/language/decorators.md. */
  decorator?: boolean;
```

Add the same optional field to `ToolMarkers` with a one-line comment saying the runtime does nothing with it.

- [ ] **Step 5: Add the keyword to every existing decorator**

By hand in `stdlib/strategy.agency` (`export decorator def guarded(`), the agency-js agent, and the seven unit test files. Over `tests/`, `sed -i '' -E 's/^def ([A-Za-z_]+)\((.*)call: Call/decorator def \1(\2call: Call/'` then `grep -rn "call: Call" tests stdlib lib --include=*.agency --include=*.ts | grep -v "decorator def\|decorator export def\|export decorator def"` and fix what is left (multi-line parameter lists, `export def`). Keep `call: Call` and the block types where they are written; the fixtures pin that a typed decorator still works.

- [ ] **Step 6: Build, rebuild fixtures, run the decorator tests**

```bash
make > $SCRATCHPAD/b1.txt 2>&1; echo $?
make fixtures > $SCRATCHPAD/f1.txt 2>&1; echo $?
pnpm run agency test tests/agency/decorators > $SCRATCHPAD/a1.txt 2>&1; grep -E "passed|failed" $SCRATCHPAD/a1.txt | tail -2
pnpm run agency test js tests/agency-js/decorator-handoff > $SCRATCHPAD/j1.txt 2>&1; tail -2 $SCRATCHPAD/j1.txt
npx vitest run lib/parsers/function.test.ts lib/backends lib/preprocessors lib/typeChecker lib/lsp lib/compiler lib/analysis > $SCRATCHPAD/u1.txt 2>&1; grep -E "Test Files|Tests " $SCRATCHPAD/u1.txt
```
Expected: all green. `git diff --stat tests/typescriptGenerator` shows only `decorators.mjs` changed, by the marker list.

- [ ] **Step 7: Typecheck, format, commit** (`feat(decorators): decorator is a function marker; every decorator says it`)

---

### Task 2: One place that knows the shape

**Files:**
- Modify: `lib/types/function.ts:47-87` (replace `hasDecoratorShape`, `decoratorShapeProblem`, `callerSuppliedParameters` with the section below)
- Modify: `lib/parsers/parsers.ts:7539`, `lib/typeChecker/paramDefaultOrder.ts:25`, `lib/typeChecker/checker.ts:320-332, 747-758`
- Modify: `lib/compilationUnit.ts:93-105, 308-313` (`ImportedFunctionSignature.markers`); `lib/preprocessors/decoratorDesugar.ts:64-81` (`DecoratorSignature.decorator`, `decoratorLookup`)
- Test: `lib/types/function.test.ts` (the shape cases from line 35 on are replaced); `lib/preprocessors/decoratorDesugar.test.ts`; `lib/compiler/prepareProgram.test.ts` (two-file unit, `markers` on the imported signature)

**Interfaces** (all in `lib/types/function.ts`, under one heading comment "What the compiler knows about a decorator's parameters"):
- `type Decoratable = { parameters: FunctionParameter[]; markers?: FunctionMarkers }` — a def or an imported signature.
- `isDecoratorDef(def: Decoratable): boolean` — `markers?.decorator === true`. The only raw read.
- `DECORATOR_SLOT_COUNT = 2` — the record and the block.
- `recordSlotName(parameters: FunctionParameter[]): string` — the second-to-last parameter's name, or `"call"` when there are fewer than two (the editor lowers a program after reporting its problems, so the lowering must not throw on a bad decorator).
- `withDecoratorTypes(def: Decoratable): FunctionParameter[]` — for a decorator, a copy of the parameters in which an untyped second-to-last gets `{ type: "typeAliasVariable", aliasName: "Call" }` and an untyped last gets the `BlockType` that `variableTypeParser` produces for `(args: object) -> any`; for a plain def, the parameters as they are. Never mutates.
- `decoratorShapeProblem(parameters: FunctionParameter[]): string | null` — the clause after "is declared as a decorator, but " (spec section 5), checked in order: fewer than two; last does not take a block (`lastParameterTakesBlock`, unchanged); second-to-last has a hint that is neither `typeAliasVariable` `Call` nor primitive `any`; either slot has a default; either slot is variadic.
- `callerSuppliedParameters(def: Decoratable): FunctionParameter[]` — all, or all but the last `DECORATOR_SLOT_COUNT` for a decorator.
- `ImportedFunctionSignature.markers?: FunctionMarkers`, so `isDecoratorDef` works on an import. Kept as a field rather than a `unit.decoratorFunctions` registry because the predicate needs the def and the signature to have the same shape; the `registerMarkers` comment is updated to say the field is where a marker that describes a signature goes, and the registries are for markers that describe a call site.
- `DecoratorSignature = { parameters; imported: boolean; decorator: boolean }` from `decoratorLookup`, `decorator` via `isDecoratorDef`.
- In the checker: `hiddenDecoratorArguments(call)` is `call.decorator === undefined ? 0 : DECORATOR_SLOT_COUNT`; `writableParameterNames` slices the same count; and the decorator branch of `checkSingleFunctionCall` returns early when the lookup says the target is not a decorator or `decoratorShapeProblem` is non-null (no diagnostic yet; Task 4 adds them). Build the lookup with `decoratorLookup(ctx.functionDefs, ctx.importedFunctions)`, the same one the stage uses.

- [ ] **Step 1: Write the failing tests** in `lib/types/function.test.ts`

Use `variableTypeParser` from `lib/parsers/parsers.ts` for hints, as `lib/parsers/typeHints.test.ts` does; name the helper `typeOf(text)` and have it throw if the parse fails.

```ts
const param = (name: string, extra: Partial<FunctionParameter> = {}): FunctionParameter =>
  ({ type: "functionParameter", name, ...extra }) as FunctionParameter;
const blockParam = (name = "block") => param(name, { typeHint: typeOf("(args: object) -> any") });
const decorator = (parameters: FunctionParameter[]) => ({ parameters, markers: { decorator: true } });

describe("isDecoratorDef", () => {
  it("is the marker and nothing else", () => {
    expect(isDecoratorDef(decorator([]))).toBe(true);
    expect(isDecoratorDef({ parameters: [param("call"), blockParam()] })).toBe(false);
  });
});

describe("recordSlotName", () => {
  it("is the second-to-last parameter, or call when there is no such slot", () => {
    expect(recordSlotName([param("tag"), param("ctx"), blockParam()])).toBe("ctx");
    expect(recordSlotName([blockParam()])).toBe("call");
  });
});

describe("decoratorShapeProblem", () => {
  it("accepts your args, then an untyped record slot, then a block", () => {
    expect(decoratorShapeProblem([param("tag"), param("call"), blockParam()])).toBeNull();
  });
  it("accepts any names and an untyped block", () => {
    expect(decoratorShapeProblem([param("ctx"), param("body")])).toBeNull();
  });
  it("accepts Call and any on the record slot", () => {
    expect(decoratorShapeProblem([param("call", { typeHint: typeOf("Call") }), blockParam()])).toBeNull();
    expect(decoratorShapeProblem([param("call", { typeHint: typeOf("any") }), blockParam()])).toBeNull();
  });
  it("needs two parameters", () => {
    expect(decoratorShapeProblem([blockParam()])).toBe(
      "a decorator takes at least two parameters: the call record and the body as a block.",
    );
  });
  it("needs a block last", () => {
    expect(decoratorShapeProblem([param("call"), param("x", { typeHint: typeOf("number") })])).toBe(
      "its last parameter must take the body as a block, such as `block: (args: object) -> any`. Found 'x: number'.",
    );
  });
  it("refuses a record slot typed as anything but Call or any", () => {
    const params = [param("call", { typeHint: typeOf("Call") }), param("tag", { typeHint: typeOf("string") }), blockParam()];
    expect(decoratorShapeProblem(params)).toBe(
      "'tag' receives the call record, so its type must be `Call` or left off.",
    );
  });
  it("refuses a default on either slot", () => {
    const defaulted = { ...blockParam(), defaultValue: { type: "null" } } as FunctionParameter;
    expect(decoratorShapeProblem([param("call"), defaulted])).toBe(
      "'block' has a default, and a decorator always receives the call record and the block. Remove the default.",
    );
  });
  it("refuses a variadic slot", () => {
    expect(decoratorShapeProblem([param("call"), param("block", { variadic: true })])).toBe(
      "'block' is variadic, but the call record and the block are one argument each.",
    );
  });
});

describe("withDecoratorTypes", () => {
  it("fills Call and the block type on untyped slots and keeps written ones", () => {
    const [tag, ctx, body] = withDecoratorTypes(decorator([param("tag", { typeHint: typeOf("string") }), param("ctx"), param("body")]));
    expect(tag.typeHint).toEqual(typeOf("string"));
    expect(ctx.typeHint).toEqual(typeOf("Call"));
    expect(body.typeHint).toEqual(typeOf("(args: object) -> any"));
  });
  it("keeps a narrower block type", () => {
    const [, block] = withDecoratorTypes(decorator([param("call"), param("block", { typeHint: typeOf("() -> string") })]));
    expect(block.typeHint).toEqual(typeOf("() -> string"));
  });
  it("leaves a plain def alone and never mutates", () => {
    const input = [param("call"), param("block")];
    expect(withDecoratorTypes({ parameters: input })).toBe(input);
    withDecoratorTypes(decorator(input));
    expect(input[0].typeHint).toBeUndefined();
  });
});

describe("callerSuppliedParameters", () => {
  it("drops the last two only for a decorator", () => {
    const parameters = [param("a"), param("call"), blockParam()];
    expect(callerSuppliedParameters(decorator(parameters)).map((p) => p.name)).toEqual(["a"]);
    expect(callerSuppliedParameters({ parameters }).map((p) => p.name)).toEqual(["a", "call", "block"]);
  });
});
```

In `decoratorDesugar.test.ts`: "the lookup says whether a name is a decorator" for a local marked def, a local plain def, and an imported one. In `prepareProgram.test.ts`: the two-file case asserts `unit.importedFunctions.logged.markers` equals `{ decorator: true }`.

- [ ] **Step 2: Run to verify failure**, `npx vitest run lib/types/function.test.ts lib/preprocessors/decoratorDesugar.test.ts lib/compiler/prepareProgram.test.ts > $SCRATCHPAD/t2.txt 2>&1`

- [ ] **Step 3: Implement the section, delete `hasDecoratorShape`, and fix the callers `pnpm run typecheck` names.** The parser passes `result` (it has `markers` by line 7539); `paramDefaultOrder` passes `node`; the checker as in the Interfaces block.

- [ ] **Step 4: Run the unit tests above plus `lib/parsers/function.test.ts lib/typeChecker`, then `make`, then the decorator fixtures** (the Task 1 Step 6 commands). Expected: all green, since every decorator now says the keyword.

- [ ] **Step 5: Typecheck, format, commit** (`refactor(decorators): one place knows the shape; markers on imported signatures`)

---

### Task 3: The fill, the record slot's name, and the stage's two new checks

**Files:**
- Modify: `lib/compilationUnit.ts:308` (parameters through `withDecoratorTypes`); `lib/preprocessors/decoratorDesugar.ts` (`desugarDecorators` fill loop; `decoratorCall` record name; `decoratorProblems`, `problemWithTag`, and the doc comment at 271-285)
- Test: `lib/preprocessors/decoratorDesugar.test.ts`; `tests/agency/decorators/compile-errors/`

**Interfaces:**
- `desugarDecorators` sets `def.parameters = withDecoratorTypes(def)` on every function node, before the lowering loop. Order matters: `callRecord` leaves block-typed parameters out of a decorated decorator's own record, so the fill must run first or an untyped block slot lands in `call.args`. The symbol table built before the lowering keeps the def's original array by reference, so a decorator's own file has two views: the def (filled) and the symbol (as written). Importers get the filled view from `buildCompilationUnit`.
- `decoratorCall` names the record argument `recordSlotName(signature.parameters)`, or `"call"` when the signature is unknown.
- New exports from `decoratorDesugar.ts`, data not prose, shared with the checker in Task 4:
  - `type DecoratorDefProblem = { name: string; problem: string; loc: SourceLocation | undefined }`; `decoratorDefProblems(nodes: AgencyNode[]): DecoratorDefProblem[]` — every function node with `isDecoratorDef` whose `decoratorShapeProblem` is non-null.
  - `type TagProblem = { kind: "notADecorator" } | { kind: "shape"; problem: string }`; `tagProblem(signature: DecoratorSignature): TagProblem | null` — `notADecorator` when `!signature.decorator`; `shape` when `signature.imported` and the shape problem is non-null; else null. A local decorator's shape is reported at the def by `decoratorDefProblems`, not at the tag.
- `decoratorProblems` renders both through the registry: `diagnostic("decoratorShape", { name, problem }, loc).message` and `diagnostic("notADecorator", { name, target }, loc).message`. `problemWithTag` calls `tagProblem` after the unknown-name and JavaScript checks. The unknown-name message now reads "A decorator is a `decorator def` whose last two parameters are the call record and a block; declare or import 'd'."

- [ ] **Step 1: Write the failing unit tests**

```ts
it("fills the record and block types on every decorator def, before lowering", () => {
  // decorator def outer(call, block) + @outer decorator def inner(call, block) + @inner def f(a: number)
  // after desugarDecorators: inner.parameters typed Call and the block type; the __call_0 record
  // declared in inner's lowered body has entries for `call` only (the block slot is left out).
});

it("reports a decorator def in the wrong shape at the def, once", () => {
  const problems = problemsFor('decorator def d(call: Call, tag: string, block) { return block() }\n@d("t")\ndef f(): string { return "x" }');
  expect(problems.map((p) => p.message)).toEqual([
    "'d' is declared as a decorator, but 'tag' receives the call record, so its type must be `Call` or left off.",
  ]);
  expect(problems[0].loc?.line).toBe(0);
});

it("refuses a tag on a plain def whatever its shape", () => {
  const problems = problemsFor('def d(call: Call, block: () -> any): any { return block() }\n@d\ndef f(): string { return "x" }');
  expect(problems.map((p) => p.message)).toEqual([
    "'d' is not a decorator, so '@d' cannot go on 'f'. Declare it as `decorator def d(...)`.",
  ]);
});

it("passes the record under the decorator's own slot name", () => {
  // decorator def d(ctx, body) ... @d def f(a: number): the lowered call's named argument is `ctx`
});
```

- [ ] **Step 2: Rework the compile-error fixtures** in `tests/agency/decorators/compile-errors/`

- Delete `call-not-second-to-last.*`. Add `record-slot-typed-wrong.agency` (`decorator def d(call: Call, tag: string, block)` plus a tag) expecting `'d' is declared as a decorator, but 'tag' receives the call record`.
- Add `not-a-decorator.agency`: a plain def with the old shape used as a tag, expecting `'tagged' is not a decorator, so '@tagged' cannot go on 'greet'`.
- Add `one-parameter.agency`: `decorator def d(block)` expecting `a decorator takes at least two parameters`.
- Add `variadic-block.agency`: `decorator def d(call, ...block)` expecting `'block' is variadic`.
- `no-block-parameter.*`: expected text becomes `'tagged' is declared as a decorator, but its last parameter must take the body as a block`.
- `default-on-call-or-block.*`: expected text becomes `'block' has a default, and a decorator always receives`.
- `decorate-each-other.*`, `from-javascript.*`, `on-node.*`, `unknown-name.*`: messages unchanged (Task 1 added the keyword).

- [ ] **Step 3: Run to verify failure**, then implement. Importing `diagnostic` from `lib/typeChecker/diagnostics.ts` into the preprocessor is fine: that module imports only types.

- [ ] **Step 4: Add the two diagnostics to the registry now**, since the stage renders from it: `decoratorShape` AG6043 and `notADecorator` AG6044 with the messages in Global Constraints, and explanations (at least 100 characters, no `${`). `make diagnostics-docs` regenerates `docs/site/diagnostics/`; `make` copies `docs/site/diagnostics` into `stdlib/docs/`; commit both.

- [ ] **Step 5: Run** `npx vitest run lib/preprocessors lib/typeChecker/diagnosticExplanations.test.ts`, then `pnpm run build` and `pnpm run agency test tests/agency/decorators` (all of it, including `compile-errors`). Expected: green.

- [ ] **Step 6: Typecheck, format, commit** (`feat(decorators): slots by position; shape checked at the def; a tag needs a decorator def`)

---

### Task 4: The checker reports both, the editor shows each once

**Files:**
- Modify: `lib/typeChecker/checker.ts:320-332`; create `lib/typeChecker/decoratorDefs.ts` (`checkDecoratorDefs(ctx)`), registered beside `checkParamDefaultOrder` in `lib/typeChecker/index.ts`; `lib/lsp/diagnostics.ts:127-131`
- Test: `lib/typeChecker/decoratorChecks.test.ts`; `lib/lsp/diagnostics.test.ts`

**Interfaces:**
- `checkDecoratorDefs` maps `decoratorDefProblems(ctx.programNodes)` to `diagnostic("decoratorShape", { name, problem }, loc)`.
- The call branch: `const found = tagProblem(lookup(call.functionName))`; `notADecorator` pushes AG6044 at `call.loc` and returns; `shape` pushes AG6043 at `call.loc` (imported only) and returns. A local decorator with a bad shape returns without a diagnostic, because checking the tag's arguments against the wrong slots would add a misleading error, and the def already carries AG6043.
- The editor drops a checker error whose `name` is `decoratorShape` or `notADecorator` when `prepared.diagnostics` has a `decorators` stage entry.

- [ ] **Step 1: Write the failing tests** in `decoratorChecks.test.ts`, replacing the "decorator shape in the checker" describe

```ts
it("reports AG6044 at a tag on a plain def when the checker runs on its own", () => {
  const src = 'def logged(call: Call, block: () -> any): any { return block() }\n@logged\ndef f(): string { return "x" }\n';
  const [error] = withCode(typecheckSource(src), "notADecorator");
  expect(error.code).toBe("AG6044");
  expect(error.message).toBe("'logged' is not a decorator, so '@logged' cannot go on 'f'. Declare it as `decorator def logged(...)`.");
  expect(error.loc?.line).toBe(lineOf(src, "@logged"));
});

it("reports AG6043 once at a decorator def in the wrong shape, and nothing at its tags", () => {
  const src = 'decorator def d(block) { return block() }\n@d\ndef f(): string { return "x" }\n';
  const errors = typecheckSource(src).filter((e) => e.severity === "error");
  expect(errors.map((e) => [e.code, e.loc?.line])).toEqual([["AG6043", 0]]);
});

it("types untyped slots so the body checks: call.name is a string and block() is allowed", () => {
  const src = "decorator def d(call, block) {\n  const n: string = call.name\n  return block()\n}\n";
  expect(typecheckSource(src).filter((e) => e.severity === "error")).toEqual([]);
});

it("checks a direct call to a decorator like any call", () => {
  const src = BUDGETED + 'node main() {\n  budgeted(1, call: { name: "x", args: {} }) { return "s" }\n  budgeted(1) { return "s" }\n}\n';
  const errors = typecheckSource(src).filter((e) => e.severity === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0].loc?.line).toBe(lineOf(src, "budgeted(1) {"));
});
```

Update the existing "reports a wrong-shape decorator from the stage and as AG6043" test: a `decorator def` in the wrong shape; the stage reports at the def and the checker's one error is AG6043 at the def. In `lsp/diagnostics.test.ts`, keep the wrong-shape test with the keyword and add one for a tag on a plain def: exactly one diagnostic containing `is not a decorator`.

- [ ] **Step 2: Run to verify failure, implement, run to verify pass.** Files: `npx vitest run lib/typeChecker lib/lsp > $SCRATCHPAD/t4.txt 2>&1`.

- [ ] **Step 3: Typecheck, format, commit** (`feat(typechecker): AG6044 notADecorator; AG6043 from the checker too`)

---

### Task 5: The new runtime cases

**Files:**
- Create under `tests/agency/decorators/`: `free-slot-names.agency`, `direct-call.agency`, `imported-decorator.agency` + `imported-decorator-helpers.agency`, `reexported-decorator.agency` + `reexported-decorator-helpers.agency` + `reexported-decorator-lib-helpers.agency`, `decorated-decorator-untyped.agency`, each with a `.test.json` (`expectedOutput` is the JSON of the value; copy `call-record.test.json`). The `-helpers.agency` suffix is the convention for a file the runner must not treat as a test (`callback-imported-helpers.agency`).

- [ ] **Step 1: Write the tests**

`free-slot-names.agency`, expected `"g:n=1:n=2:n=5"`:

```
// The two slots can have any names and no types; body() runs with defaults.
decorator def twice(ctx, body) {
  const first = body(ctx.args)
  const second = body({ ...ctx.args, n: ctx.args.n + 1 })
  const third = body()
  return "${ctx.name}:${first}:${second}:${third}"
}

@twice
def g(n: number = 5): string {
  return "n=${n}"
}

node main() {
  return g(1)
}
```

`direct-call.agency`, expected `"t:direct:body"`: `decorator def tagged(tag: string, call, block)` returning `"${tag}:${call.name}:${block()}"`, called from `main` as `tagged("t", call: { name: "direct", args: {} }) { return "body" }`.

`imported-decorator.agency`, expected `"f=3"`: the helpers file has `export decorator def logged(call, block) { return "${call.name}=${block(call.args)}" }`; the test imports it, decorates `def f(a: number): number { return a }`, returns `f(3)`.

`reexported-decorator.agency`, expected `"f=3"`: the lib helpers file declares `logged` as above; the middle helpers file has `export { logged } from "./reexported-decorator-lib-helpers.agency"`; the test imports from the middle file. This is the first fixture that runs a decorator through the re-export wrapper (`buildFunctionWrapper` passes the block on positionally). If it fails, fix the wrapper, not the test.

`decorated-decorator-untyped.agency`, expected `"outer:inner:f=1"`: `decorator def outer(call, block)` returns `"outer:${block(call.args)}"`; `@outer decorator def inner(call, block)` returns `"inner:${call.name}=${block(call.args)}"` hmm, `call.name` inside `inner` is the decorated def's name, so write `"inner:${block(call.args)}"` and have `def f(a: number): string { return "f=${a}" }` under `@inner`. Expected `"outer:inner:f=1"` for `f(1)`. This pins that the fill runs before the lowering: with the order wrong, `inner`'s block slot would land in the record `outer` receives.

- [ ] **Step 2: Build, run them**: `pnpm run build` then `pnpm run agency test tests/agency/decorators > $SCRATCHPAD/a5.txt 2>&1`. Expected: every fixture passes.

- [ ] **Step 3: `make fixtures`, then run `pnpm run agency test js tests/agency-js/decorator-handoff`.**

- [ ] **Step 4: Typecheck, format, commit** (`test(decorators): free names, direct call, imported and re-exported decorators, decorated decorator`)

---

### Task 6: Docs

**Files:**
- Modify: `docs/site/guide/decorators.md`; `docs/dev/language/decorators.md`; `stdlib/index.agency:71-74` (the `Call` doc comment: "in its second-to-last parameter, whatever that parameter is called"); `CLAUDE.md` and `.claude/skills/agency-language-docs/SKILL.md` index lines for `decorators.md`; the spec's status line
- Regenerate: `make` (stdlib docs and the `stdlib/docs/` copies); commit `docs/site/stdlib/strategy.md` and `stdlib/docs/`

- [ ] **Step 1: The guide.** Every code block says `decorator def`; the first example drops the types on `call` and `block`; one keeps `block: () -> string`. A short "Calling a decorator directly" section with the record literal. "The rules" in this order: a decorator says `decorator def`; its last two parameters are the call record and the block, by position, named as you like, typed by the compiler unless you type them; a decorator can be called directly with a record literal; only a `decorator def` can be a tag; decorators go on a def only; the model never sees a decorator; a decorator's effects count as the function's. "Mistakes and what they say" lists the two new messages.

- [ ] **Step 2: The dev doc.** Mechanism and rule only. The marker's path in one paragraph pointing at `handoff` as the twin. The one section of `function.ts` and the rule that nothing else reads `markers.decorator`. The fill: two call sites, one helper, why it runs before the lowering, the two views of a decorator's parameters (def filled, symbol as written) and which consumers read which, and that a decorator def's tool schema now has an object schema for its record slot. Why the record slot's written type must be `Call` or `any`. Why a direct call needs no helper. The re-export wrapper path. `dec.agency` in the main checkout is the owner's untracked example; say in the PR that it needs the keyword.

- [ ] **Step 3: Read `docs/dev/contributing/verbal-tics.md` and cut what it names.**

- [ ] **Step 4: Commit** (`docs(decorators): the decorator keyword`)

---

## Verify before opening the PR

```bash
pnpm run typecheck && pnpm run lint:structure && pnpm run fmt:ts
npx vitest run lib/types lib/parsers/function.test.ts lib/backends lib/preprocessors lib/typeChecker lib/lsp lib/compiler lib/analysis lib/stdlibCapabilities.test.ts > $SCRATCHPAD/final.txt 2>&1; grep -E "Test Files|Tests " $SCRATCHPAD/final.txt
pnpm run agency test tests/agency/decorators > $SCRATCHPAD/final-agency.txt 2>&1; tail -3 $SCRATCHPAD/final-agency.txt
pnpm run agency test js tests/agency-js/decorator-handoff > $SCRATCHPAD/final-js.txt 2>&1; tail -2 $SCRATCHPAD/final-js.txt
```

Then `git diff main --stat`, read the hand-written diff once against `docs/dev/contributing/anti-patterns.md`, and open the PR against `main` with a description written to a file. It closes the "name-only shape" follow-up from #1269.

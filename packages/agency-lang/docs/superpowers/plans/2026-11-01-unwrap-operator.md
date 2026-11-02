# The `?` Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `?` operator to Agency, a postfix `?` that unwraps a `Result` or returns its failure from the enclosing function, lowered to the hand-written `if (x is failure) { return x }` form so interrupts and resume are untouched.

**Architecture:** `?` is a new access-chain element kind, `unwrap`, parsed where `.name` and `[i]` are parsed. The type checker types it and refuses it where it cannot be lowered. The `hoistCalls` preprocessor pass splits a chain at each `unwrap` into a hoisted temp plus an `if (isFailure(temp)) { return temp }` guard. Codegen never sees an `unwrap`. Optional chaining (`?.`) is removed, because `?.` now means "unwrap, then access".

**Tech Stack:** TypeScript, the tarsec parser combinators, vitest unit tests, `tests/agency` execution tests, `tests/agency-js` multi-step tests.

**Spec:** `docs/superpowers/specs/2026-11-01-unwrap-operator-design.md` (same worktree). Read it first; this plan argues from it.

## Global Constraints

- Work in the worktree at `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-question-mark-operator/packages/agency-lang`, branch `adit/question-mark-operator`. Every command below runs from that directory.
- `lib/runtime/` does not change. If a task seems to need a runtime change, stop and re-read the spec's "Lowering" section.
- Names. In prose, docs, commit messages, and the PR, this is "the `?` operator", Rust's name for it. Never "try operator" (Agency has a `try` keyword) and never "unwrap operator". In code the chain element kind is `unwrap`, because `?` cannot be an identifier, so identifiers are `hasUnwrap`, `unwrapChecks.ts`, and the `unwrap...` diagnostic names.
- Agency reserves names starting with `__`. Temps are `__hoist_N` from the existing per-frame counter in `hoistCalls.ts`; no new prefix.
- No dynamic imports, objects not maps, arrays not sets, `type` not `interface` (repo rules in `CLAUDE.md`).
- Commit messages go in a file and are passed with `git commit -F`, never inline (apostrophes break the shell). Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `$SCRATCH` below is the session scratchpad directory; export it once before starting.
- After every TypeScript edit: `pnpm run typecheck`. Before any `tests/agency` or `tests/agency-js` run: `pnpm run build`. Save every test run's output to a file under the scratchpad and read the file; do not rerun to see what failed.
- The agency-js runner never writes `fixture.json`. With no fixture it prints the result and reports a failure; with one it diffs. To record a fixture: run the test, read the printed result, check every value by hand against the task's list, write it to `fixture.json` yourself, and run once more to see it pass.
- Do not run the whole `tests/agency` suite locally. Run only the files a task names. CI runs the rest.
- Run `pnpm run fmt:ts` on the files you touched before each commit. CI fails on unformatted files.
- Diagnostic codes and messages are the spec's, verbatim: AG2023 `unwrapNonResult`, AG2024 `unwrapReturnTypeNotResult`, AG1021 `unwrapInOpaquePosition`, AG1022 `unwrapOutsideBody`, AG1023 `unwrapInHandlerBody`, AG1024 `unwrapInParallelArm`, AG1025 `unwrapInAssignmentTarget`.
- Prose in docs and comments follows `~/.claude/skills/simplify-speech/general-writing-tips.md`; check drafts against `~/.claude/skills/simplify-speech/verbal-tics.md`.

## Review Focus

Inputs the spec implies but no single task's happy path exercises. Each has a test pinned to the task named.

1. `obj?.name` written by old code on a plain object: must be AG2023, never a silent null. Pinned in Task 3.
2. Regressions in the other uses of `?`: `a ?? b` must still parse as nullish coalescing, and a JavaScript ternary (`cond ? a : b`, which Agency does not allow) must still be refused with the existing "Agency has no ternary" message, in both the spaced and the unspaced spelling. Pinned in Task 2.
3. `?` whose operand raises an interrupt inside an enclosing `handle ... with reject`: the function must return the rejected failure and run nothing after the `?`. Pinned in Task 8.
4. `?` in a `while` condition: the loop rewrite must place the guard inside the loop body so the function returns on failure instead of looping. Pinned in Task 8.
5. A `?` under `with approve` whose operand's arguments contain another call: every temp must land inside the generated `handle` block, not before it. Pinned in Task 6.

---

### Task 1: Remove optional chaining

Optional chaining is removed before `?` is added, so the parser never holds both meanings of `?.` at once.

**Files:**
- Modify: `lib/types/access.ts` (drop `optional?: boolean` from every `AccessChainElement` variant)
- Modify: `lib/parsers/parsers.ts:3382-3386` (`dotParser`), `:3527-3530` (`callChainParser`)
- Modify: `lib/backends/agencyGenerator.ts:2215-2237` (`processAccessChainElement`)
- Modify: `lib/backends/typescriptBuilder.ts:1267-1360` (`processValueAccess`: the `optional:` fields, the `ts.bool(true)` optional arguments, and the `__nn` placement comment and branch about optional indexes)
- Modify: `lib/backends/typescriptBuilder/pipeReceiverCodegen.test.ts` (delete the test "preserves optional chaining (`?.`) on the receiver")
- Modify: `lib/parsers/access.test.ts` (delete the 14 tests that assert `optional: true`, including `arr?.[1:3]` at line 267)
- Modify: `tests/agency/nullish-operators.agency` and `.test.json` (delete nodes `testOptionalChainingOnNull`, `testOptionalIndex`, `testCombined`, `testOptionalMethodCall`, and the `?.` line in `testNullishWithUndefined`; delete their entries in the JSON)
- Delete: `tests/agency/dynamic-functions/optional-chaining-call.agency` and its `.test.json`; `tests/agency/dynamic-functions/optional-call-chain.agency` and its `.test.json`
- Modify: `tests/typescriptGenerator/slice.agency` (delete the `optionalSlice` line), then regenerate `slice.mjs`
- Modify: `tests/agency/result/pipe-receiver-precedence.agency:57-61` (delete the comment about `?.`)
- Modify: `tests/agency-js/index-missing-key-null/`: delete the node `optChainNoThrow` (`agent.agency:26-29`) and the comment block above it; in `test.js` delete the `optChainNoThrow` import, the `opt` line, and the two keys `optChainDeepIsNull` and `optNullIndexIsUndefined`; delete those two keys from `fixture.json`
- Modify: `docs/dev/language/null-and-undefined.md:114` and `:140-141` (optional chaining is no longer a deferred feature; it is gone)
- Modify: `lib/backends/typescriptBuilder.ts:1340-1355` (the comment explaining the optional-index exception goes with the exception)

**Interfaces:**
- Produces: `AccessChainElement` with no `optional` field. Task 2 adds the `unwrap` variant to this union.

- [ ] **Step 1: Delete the `optional` field and let the compiler find every reader**

Remove `optional?: boolean` from all five variants in `lib/types/access.ts`. Run `pnpm run typecheck` and fix each error by deleting the optional branch it points at. In `typescriptBuilder.ts` the `__nn` wrapping rule at line 1357 becomes unconditional on `lastElement?.kind === "index"`.

- [ ] **Step 2: Remove the two parser branches**

The parser is written with tarsec, a parser-combinator library that is easy to misuse. Before deleting anything, read `dotParser` (`parsers.ts:3383`), `callChainParser` (`:3527`), and `chainElementParser` (`:3554`) and note three things Task 2 will copy: a chain element is probed with `str("?.")` on the raw input and no whitespace skipping; the alternatives are combined with `or` inside a `memo`; and a probe that fails returns a plain `failure(...)`, never a committed failure, so the next alternative can be tried. The deleted text stays reachable with `git show <this commit>^:packages/agency-lang/lib/parsers/parsers.ts`.

`dotParser` becomes `char(".")` and `dotMethodCallParser` stops reading a boolean from it; `callChainParser` no longer looks for `?.`. Delete the fourteen `optional` tests in `lib/parsers/access.test.ts`.

- [ ] **Step 3: Run the parser, generator, and builder unit tests**

Run: `pnpm test:run lib/parsers/access.test.ts lib/backends/agencyGenerator.roundtrip.test.ts lib/backends/typescriptBuilder/pipeReceiverCodegen.test.ts > "$SCRATCH/t1-unit.txt" 2>&1; tail -20 "$SCRATCH/t1-unit.txt"`
Expected: all pass.

- [ ] **Step 4: Update the execution fixtures**

Edit the `.agency` and `.test.json` files listed above, delete the two `dynamic-functions` tests, run `make fixtures` to regenerate `slice.mjs`, then `pnpm run build` and re-record the agency-js fixture:

Make the `index-missing-key-null` edits listed above (the two fixture keys are `optChainDeepIsNull` and `optNullIndexIsUndefined`; nothing else in `fixture.json` changes), then run: `pnpm run agency test js tests/agency-js/index-missing-key-null > "$SCRATCH/t1-js.txt" 2>&1; tail -8 "$SCRATCH/t1-js.txt"`. Expected: pass.

- [ ] **Step 5: Run the touched agency tests**

Run: `pnpm run agency test tests/agency/nullish-operators.test.json > "$SCRATCH/t1-agency.txt" 2>&1; tail -5 "$SCRATCH/t1-agency.txt"`
Expected: pass.

- [ ] **Step 6: Commit**

Message file: "Remove optional chaining (`?.`) from the language" with a body saying `?.` is being reassigned to the `?` operator, no stdlib or agent code used it, and which tests were deleted.

---

### Task 2: Parse and print the `unwrap` element

**Files:**
- Modify: `lib/types/access.ts` (add the variant and two helpers)
- Modify: `lib/parsers/parsers.ts:3554-3557` (`chainElementParser`), `:4515-4535` (`ternaryMarker`, `ternaryRefusal`)
- Create: `lib/parsers/unwrap.test.ts`
- Modify: `lib/backends/agencyGenerator.ts:2215` (`processAccessChainElement`)
- Create: `lib/backends/agencyGenerator.unwrap.test.ts`
- Modify: `lib/utils/node.ts:141-158` (`expressionToString`, the `valueAccess` case)
- Modify: `lib/utils/expressionSlots.ts:228-250` (the chain-entry slots: an `unwrap` has none; add the explicit `kind === "unwrap"` early return so the ruling is visible)
- Modify: `lib/typeChecker/pathSegments.ts:64-68` (an `unwrap` element yields no segment, which ends the path)
- Modify: `lib/backends/typescriptGenerator/typeToString.ts:40-50` (the chain switch prints `?`)
- Modify: `lib/backends/typescriptBuilder/assignmentEmitter.ts:100-112` (the write-target chain switch throws the Task 7 tripwire message; AG1025 keeps users from reaching it)

The chain code is mostly typed `any`, so `pnpm run typecheck` will not find every switch over `kind`. Grep for `"methodCall"` across `lib/` and visit each hit.

**Interfaces:**
- Produces, in `lib/types/access.ts`:
  - the variant `{ kind: "unwrap" }` on `AccessChainElement`;
  - `export function isUnwrapElement(element: AccessChainElement): element is { kind: "unwrap" }`;
  - `export function hasUnwrap(access: ValueAccess): boolean` (true when any chain element is an unwrap).
- Produces the parse shapes the spec's "Grammar" section lists, with `?` adjacent to the operand and not followed by `?`.

- [ ] **Step 1: Write the failing parser tests**

`lib/parsers/unwrap.test.ts`, using the `parseValue` helper pattern from `lib/parsers/cast.test.ts`:

```ts
it("foo()? is a value access with one unwrap element", () => {
  const parsed = parseValue("foo()?") as any;
  expect(parsed.value).toEqualWithoutLoc({
    type: "valueAccess",
    base: { type: "functionCall", functionName: "foo", arguments: [] },
    chain: [{ kind: "unwrap" }],
  });
});
it("x? unwraps a variable", ...)                       // chain: [unwrap]
it("foo()?.name continues the chain after the unwrap", ...) // [unwrap, property name]
it("a()?.b()?.c()? interleaves unwraps and method calls", ...) // five elements in order
it("foo()?[0] indexes after the unwrap", ...)
it("(x)?.name unwraps a parenthesized expression", ...)
it("foo() ? with a space is not an unwrap", () => {   // statements[0].value is the bare call; the rest is junk the body parser reports
it("a ?? b is still nullish coalescing", ...)          // binOpExpression with operator "??"
it("cond ? a : b gives the ternary message", () => { expect(parsed.success).toBe(false); expect(parsed.message).toContain("Agency has no ternary") })
it("cond? a : b gives the ternary message", ...)       // same expectation
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:run lib/parsers/unwrap.test.ts > "$SCRATCH/t2-parse.txt" 2>&1; tail -30 "$SCRATCH/t2-parse.txt"`
Expected: FAIL (the `?` is unparsed junk today).

- [ ] **Step 3: Add the variant and the parser**

Add `{ kind: "unwrap" }` to `AccessChainElement` and the two helpers. In `chainElementParser`, add a fourth alternative, an `unwrapChainParser` that matches `char("?")` followed by `not(char("?"))` and returns `{ kind: "unwrap" }`. Model it on the `?.` probe that Task 1 removed (`git show <task 1 commit>^:packages/agency-lang/lib/parsers/parsers.ts`, `callChainParser`): probe the raw input, return a plain `failure` on a miss so `or` tries the next alternative, and keep it inside the existing `memo`'d `or`. Do not add whitespace skipping, and do not write a committed failure from this probe. Because every chain element parser is tried directly after the previous element with no whitespace skipping, adjacency comes for free; confirm with the "with a space" test.

For the ternary refusal: keep `ternaryMarker` as is, and extend `ternaryRefusal(rest)` with a second probe that runs when the parsed expression is a `valueAccess` whose last element is an unwrap: run the existing `tail` parser (lift it out of the function into a module constant beside `ternaryMarker`) on `rest` directly and return the same committed failure. `ternaryRefusal` needs the parsed expression for that, so its signature becomes `(result: Expression, rest: string)`.

- [ ] **Step 4: Print it**

`processAccessChainElement` gets `case "unwrap": return "?"`. `expressionToString` in `node.ts` gets `case "unwrap": code += "?"`. `expressionSlots` returns `[]` for an unwrap entry, with the comment "an unwrap has no expression of its own; the pass splits the chain at it". `pathSegments.ts` returns `null` for an unwrap element, which already ends the path.

`lib/backends/agencyGenerator.unwrap.test.ts`, following `agencyGenerator.cast.test.ts`:

```ts
it("prints an unwrap after a call", () => { expect(print(access(call("foo"), [unwrap]))).toBe("const p = foo()?") });
it("prints a chain with unwraps in order", ...)   // "const p = a()?.b()?.c()?"
```

- [ ] **Step 5: Run parser, generator, slots, and round-trip tests**

Run: `pnpm test:run lib/parsers/unwrap.test.ts lib/backends/agencyGenerator.unwrap.test.ts lib/backends/agencyGenerator.roundtrip.test.ts lib/utils/expressionSlots.test.ts > "$SCRATCH/t2-all.txt" 2>&1; tail -20 "$SCRATCH/t2-all.txt"`
Expected: PASS.

- [ ] **Step 6: Commit**

"Parse and print the `?` operator `?`".

---

### Task 3: Type the operand (AG2023)

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts` (one entry)
- Modify: `lib/typeChecker/synthesizer.ts:1265-1372` (`synthValueAccess`, the chain walk)
- Create: `lib/typeChecker/unwrap.test.ts`

**Interfaces:**
- Consumes: `isUnwrapElement` from Task 2.
- Produces: `synthValueAccess` yields the Result's success type after an unwrap element.

- [ ] **Step 1: Write the failing tests**

`lib/typeChecker/unwrap.test.ts`, using `typeCheckSource` and `errorsWithCode` as `castPositions.test.ts` does, with a prelude that declares `def parseName(text: string): Result<string> { ... }` and `def plainName(): string { ... }`:

```ts
it("the success value flows out of ?", () => { expect(allCodes(wrap(`const n: string = parseName("x")?`))).toEqual([]) });
it("? on a non-Result is AG2023", () => { expect(count(`const n = plainName()?`, "AG2023")).toBe(1) });
it("old optional chaining on an object is AG2023", () => { expect(count(`const o = { name: "a" }\n  const n = o?.name`, "AG2023")).toBe(1) });
it("? on any is any", () => { expect(allCodes(wrap(`const a: any = 1\n  const n = a?`))).toEqual([]) });
it("the chain continues with the unwrapped type", () => { expect(allCodes(wrap(`const n: number = parseName("x")?.length`))).toEqual([]) });
it("a Result alias unwraps", ...)   // `type R = Result<string>` then a def returning R
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:run lib/typeChecker/unwrap.test.ts > "$SCRATCH/t3.txt" 2>&1; tail -30 "$SCRATCH/t3.txt"`
Expected: FAIL.

- [ ] **Step 3: Add the diagnostic and the chain case**

Diagnostic entry `unwrapNonResult`, code `AG2023`, severity error, message exactly as in the spec, params `expr` and `type`. In the chain walk, before the `switch (element.kind)`, handle an unwrap element: `any` stays `any`; a resolved `resultType` becomes its `successType`; anything else pushes AG2023 (with `expressionToString` of the chain up to that element for `expr`, `formatTypeHint` for `type`) and becomes `ANY_T`.

- [ ] **Step 4: Run to see them pass, plus the existing checker suite**

Run: `pnpm test:run lib/typeChecker/unwrap.test.ts lib/typeChecker.test.ts > "$SCRATCH/t3b.txt" 2>&1; tail -20 "$SCRATCH/t3b.txt"`
Expected: PASS.

- [ ] **Step 5: Commit**

"Type the `?` operator: a Result yields its success type (AG2023)".

---

### Task 4: Refuse `?` where it cannot return or cannot be lowered (AG2024, AG1021 to AG1025)

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts` (four entries)
- Create: `lib/typeChecker/positionRefusals.ts` (the one function that turns hoist statuses into diagnostics; `castPositions.ts` is rewritten to use it)
- Modify: `lib/typeChecker/castPositions.ts:22-45` (use `positionRefusals`)
- Create: `lib/typeChecker/unwrapChecks.ts`
- Modify: `lib/typeChecker/index.ts:387` (call `checkUnwraps(ctx)` beside `checkCastPositions(ctx)`)
- Modify: `lib/preprocessors/hoistPositions.ts:104-114` (`bodyStatus`: the `with` rule)
- Modify: `lib/preprocessors/hoistPositions.test.ts` (new programs)
- Create: `lib/typeChecker/unwrapChecks.test.ts`

**Interfaces:**
- Consumes: `hoistPositions` and `HoistStatus` from `hoistPositions.ts`; `isAssignable` from `assignability.ts`; `hasUnwrap` from Task 2; `walkNodes` and `isInsideBlock` as `checkReturnTypesInScope` in `checker.ts:886` uses them.
- Produces, in `lib/typeChecker/positionRefusals.ts`: `export type RefusalTable = { stuck: string; outsideBodies: string; handlerBody: string }` (diagnostic names per status) and `export function positionRefusals<T extends AgencyNode>(positions: HoistPosition[], isTarget: (node: AgencyNode) => node is T, table: RefusalTable, params: (node: T) => Record<string, string>): TypeCheckError[]`. It holds the filter-by-status loop once. `castPositions.ts` calls it with `isCast`-and-can-pause and its three `castCanPause...` names; `unwrapChecks.ts` calls it with `hasUnwrap` and the three `unwrap...` names. Each caller is then a table and a params function, with no loop of its own.
- Produces: `export function checkUnwraps(ctx: TypeCheckerContext): void`.
- Produces, in `lib/utils/node.ts`: `export function containsUnwrap(node: AgencyNode): boolean`, written over the existing `walkNodes` generator (true when any `valueAccess` under `node` has an unwrap). Task 5 and Task 6 use it.

- [ ] **Step 1: Write the failing tests**

`lib/typeChecker/unwrapChecks.test.ts`, same harness as `castPositions.test.ts`. The prelude declares `def parseName(text: string): Result<string>`, `effect test::ask { n: number }`, and `def ask(n: number): Result<number>` that raises `test::ask`.

```ts
describe("AG2024", () => {
  it("a def declared to return string cannot use ?", () => expect(count(`def f(): string {\n  return parseName("x")?\n}`, "AG2024")).toBe(1));
  it("a def declared to return Result may", () => ... toBe(0));
  it("a def declared to return string | Result may", ... 0);
  it("a def with no declared return type is not checked", ... 0);
  it("? inside a block argument is not checked against the def", () => ... `def f(): string {\n  const xs = map([1]) as x {\n    return parseName("a")?\n  }\n  return "ok"\n}` ... 0);
});
describe("AG1021 stuck positions", () => {
  it.each(["a && parseName(\"x\")?", "a ?? parseName(\"x\")?", "parseName(\"x\")? catch \"\"", "parseName(\"x\") catch parseName(\"y\")?", "success(1) |> use(parseName(\"x\")?)", "try parseName(\"x\")?"])("refuses %s", (expr) => expect(count(`  const r = ${expr}`, "AG1021")).toBe(1));
  it("its own line is fine", ...)   // `const r = parseName("x")?` → 0
  it("under with approve is fine", ...)  // `const r = parseName("x")? with approve` → 0
});
describe("AG1022", () => { it("a module-level initializer", ...); it("a parameter default", ...) });
describe("AG1023", () => { it("a handler body", ...) });
describe("AG1024", () => {
  it("the top level of a parallel arm", () => expect(count(`  parallel {\n    const a = parseName("x")?\n    const b = parseName("y")\n  }`, "AG1024")).toBe(1));
  it("a block argument inside an arm is fine", ...)   // `parallel { const a = map([1]) as n { return parseName("x")? } ... }` → 0
});
describe("AG1025", () => { it("an assignment target", () => expect(count(`  let o: any = {}\n  o?.field = 1`, "AG1025")).toBe(1)) });
```

Add to `hoistPositions.test.ts` `PROGRAMS`: `["an unwrap under with", "const r = use(target())? with approve"]` with the expectation that `target()` is lifted (the agreement test will then demand the `with` rule in both the model and, in Task 6, the pass; until Task 6 lands this one program is expected to disagree, so add it with `it.skip` here and unskip in Task 6).

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:run lib/typeChecker/unwrapChecks.test.ts > "$SCRATCH/t4.txt" 2>&1; tail -40 "$SCRATCH/t4.txt"`
Expected: FAIL.

- [ ] **Step 3: Implement `checkUnwraps`**

Diagnostics: `unwrapReturnTypeNotResult` AG2024 (params `expr`, `name`, `type`), `unwrapInOpaquePosition` AG1021, `unwrapOutsideBody` AG1022, `unwrapInHandlerBody` AG1023, `unwrapInParallelArm` AG1024, `unwrapInAssignmentTarget` AG1025 (params `expr`), messages verbatim from the spec.

`checkUnwraps` has four parts:

1. Positions. First move the status loop out of `castPositions.ts` into `positionRefusals` and make `checkCastPositions` call it (its tests must still pass unchanged). Then `checkUnwraps` calls `positionRefusals(hoistPositions(ctx.programNodes), isUnwrapAccess, { stuck: "unwrapInOpaquePosition", outsideBodies: "unwrapOutsideBody", handlerBody: "unwrapInHandlerBody" }, (access) => ({ expr }))`. `expr` is `expressionToString` of a copy of the access whose chain has its last element removed when that element is an unwrap, so the message reads `` `foo()?` `` and not `` `foo()??` ``.
2. Return types. For each scope with a declared `returnType` (iterate as `checker.ts:167` does), walk `info.body` with `walkNodes`, skip nodes where `isInsideBlock(ancestors)`, and for each `valueAccess` with an unwrap, if `!isAssignable({ type: "resultType", successType: ANY_T, dataType: ANY_T }, info.returnType, aliases)` push AG2024 with `name: info.name`.
3. Parallel arms. `checkUnwraps` runs on the pre-desugar tree, so walk with `walkNodes` and, for a `valueAccess` with an unwrap whose nearest enclosing statement is a direct child of a `parallelBlock` arm (no block argument between), push AG1024.
4. Assignment targets. For every `assignment` node with an `accessChain` containing an unwrap, push AG1025. These chains are not expression slots, so `hoistPositions` never lists them.

In `hoistPositions.ts` `bodyStatus`: when `owner.type === "withModifier"` and `containsUnwrap(owner.statement)`, return `status` unchanged instead of `"stuck"`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test:run lib/typeChecker/unwrapChecks.test.ts lib/typeChecker/castPositions.test.ts lib/preprocessors/hoistPositions.test.ts > "$SCRATCH/t4b.txt" 2>&1; tail -20 "$SCRATCH/t4b.txt"`
Expected: PASS (with the one skipped program). The cast tests passing unchanged is what shows the shared helper kept the cast behavior.

- [ ] **Step 5: Commit**

"Refuse the `?` operator where it cannot return or be lowered (AG2024, AG1021-AG1025)". Say in the body that the "an unwrap under with" program in `hoistPositions.test.ts` is skipped on purpose until the pass learns the `with` expansion in the next commit.

---

### Task 5: Lower `?` in the hoist pass

**Files:**
- Modify: `lib/preprocessors/hoistCalls.ts:380-400` (the `valueAccess` branch of `walk`), the statement dispatcher's `valueAccess` case at `:252-258` (a bare `foo()?` statement), and the tail rule at `:296-301`
- Modify: `lib/preprocessors/hoistPositions.ts:67-75` (`statementPositions`: a `valueAccess` statement containing an unwrap extracts from its own expressions)
- Modify: `lib/preprocessors/hoistPositions.test.ts` (add `["a bare unwrap statement", "use(target())?"]` to `PROGRAMS`; the pass must lift `target()` and the model must call it liftable)
- Modify: `lib/preprocessors/hoistCalls.test.ts`
- Create: `lib/types/access.test.ts` (for `chainPieces`)

**Interfaces:**
- Consumes: `isUnwrapElement`, `containsUnwrap`; `resultCheckCall("failure", ref, loc)` from `lib/lowering/patternLowering.ts:1382`, which is the function the `is failure` pattern already lowers through. It is module-private today; export it rather than building a second `isFailure` call shape.
- Produces: the exact statement sequence in the spec's "The rewrite" section, names included.

- [ ] **Step 1: Write the failing tests**

In `hoistCalls.test.ts`, a new `describe("unwrap")` using `bodyOf` and `stmts`:

```ts
it("lowers const x = foo()? to a temp, a guard, and a value read", () => {
  const body = stmts(hoistCallsInScope(bodyOf(`def f(): Result {\n  const x = foo()?\n  return success(x)\n}`))) as any[];
  expect(body.map((n) => n.type)).toEqual(["assignment", "assignment", "ifElse", "assignment", "returnStatement"]);
  expect(body[0].variableName).toBe("__hoist_0");
  expect(body[0].value.functionName).toBe("foo");
  expect(body[1].variableName).toBe("__hoist_1");
  expect(body[1].value).toMatchObject({ type: "functionCall", functionName: "isFailure", arguments: [{ type: "variableName", value: "__hoist_0" }] });
  expect(body[2].condition).toEqual(expect.objectContaining({ type: "variableName", value: "__hoist_1" }));
  expect(body[2].thenBody).toHaveLength(1);
  expect(body[2].thenBody[0]).toMatchObject({ type: "returnStatement", value: { type: "variableName", value: "__hoist_0" } });
  expect(body[2].elseBody).toBeUndefined();
  expect(body[3]).toMatchObject({ variableName: "x", value: { type: "valueAccess", base: { value: "__hoist_0" }, chain: [{ kind: "property", name: "value" }] } });
});
it("splits a()?.b()? into two temps and two guards in order", ...)   // temps named __hoist_0, __hoist_2 hold a() and __hoist_0.value.b(); guards read __hoist_1, __hoist_3
it("keeps a trailing property access inline: foo()?.name", ...)     // last statement value is __hoist_0.value.name
it("a trailing method call at the statement tail stays inline: const x = foo()?.name.trim()", ...)   // the const's value is the chain __hoist_0.value.name.trim(); the tail rule withholds hoistSelf
it("a trailing method call in argument position hoists as a unit: g(foo()?.name.trim())", ...)        // __hoist_2 = __hoist_0.value.name.trim(), then g(__hoist_2)
it("lowers a bare statement foo(bar())?", ...)                                                        // temps for bar() and foo(...), the isFailure temp, the guard, then a bare __hoist_1.value expression statement
it("lowers let and reassignment the same way: let x = foo()? then x = bar()?", ...)   // two temp/guard groups; the second ends in a plain assignment to x
it("lowers a compound assignment: n += count()?", ...)
it("lowers a destructuring declaration: const { a, b } = pair()?", ...)              // the destructuring assignment's value is __hoist_0.value
it("hoists the operand of return foo()?", ...)                      // the return's value is __hoist_0.value, not a call
it("hoists arguments before the operand: foo(bar())?", ...)         // __hoist_0 = bar(), __hoist_1 = foo(__hoist_0), guard reads __hoist_2
it("copies the operand loc onto every emitted statement", ...)
it("uses a fresh counter inside a block argument", ...)             // `map(xs) as x { return g(x)? }`: temps inside the block body start at __hoist_0
it("does not mutate its input", ...)
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:run lib/preprocessors/hoistCalls.test.ts > "$SCRATCH/t5.txt" 2>&1; tail -40 "$SCRATCH/t5.txt"`
Expected: FAIL.

- [ ] **Step 3: Implement the split**

Two functions, so the shape of the split is data and the fold is the only imperative part:

`export function chainPieces(chain: AccessChainElement[]): { pieces: AccessChainElement[][]; trailing: AccessChainElement[] }` in `lib/types/access.ts`: a pure split of the chain at every unwrap element. `pieces` holds the elements before each unwrap (possibly empty lists), `trailing` holds the elements after the last one. For `[unwrap, b, unwrap, c]` it gives `pieces: [[], [b]]`, `trailing: [c]`. Unit-test it in a new file, `lib/types/access.test.ts` (there is none today), with that example and with a chain that has no unwrap (`pieces: []`, `trailing: whole chain`).

Then in `walk`'s `valueAccess` branch, before the existing method-call logic: if `hasUnwrap(node)`, call a new `lowerUnwraps(node, counter, temps, hoistSelf)`:

1. Walk `node.base` with `walk(base, counter, true)` and collect its temps.
2. Reduce over `chainPieces(node.chain).pieces` with the current base as the accumulator. For each piece: build `unit` = the current base if the piece is empty, else a `valueAccess` of the current base with the piece; walk the unit's argument slots with `walkSlots(unit, counter, (slot) => !methodCalls.includes(slot.expr))`, the same predicate the existing branch uses, so arguments hoist but the unit's own method calls stay attached; `ref = makeTemp(unit, temps, counter)`; `flag = makeTemp(resultCheckCall("failure", ref, loc), temps, counter)`; push the `ifElse` guard `{ type: "ifElse", condition: flag, thenBody: [{ type: "returnStatement", value: ref, loc }], loc }`; the next accumulator is `{ type: "valueAccess", base: ref, chain: [{ kind: "property", name: "value" }], loc }`.
3. If `trailing` is empty return the accumulator. Otherwise return the `valueAccess` of the accumulator with `trailing`, hoisted as a unit only if it contains a method call and `hoistSelf` is true, which is the existing rule.

The statement dispatcher's `isTail` rule withholds `hoistSelf` from a tail `valueAccess`; the split runs regardless of `hoistSelf`, so `return foo()?` hoists `foo()`.

The dispatcher's `valueAccess` case today returns `recurseSlots(stmt, counter)` with no extraction, so a bare `foo()?` statement would never reach `walk`. Give that case an unwrap rule shaped like the `functionCall` case above it: when `hasUnwrap(stmt)`, `const walked = walk(stmt, counter, false)` and return `[...walked.temps, walked.expr]`. In `hoistPositions.ts` `statementPositions`, treat a `valueAccess` statement with `hasUnwrap` as extracting, so its own expressions are `liftable`. The new agreement-test program is what pins the two together.

Keep `rewriteStatement` and `walk` under the file's `max-lines-per-function` rule by putting the split in its own function.

- [ ] **Step 4: Run to see them pass, with the position agreement test**

Run: `pnpm test:run lib/preprocessors/hoistCalls.test.ts lib/preprocessors/hoistPositions.test.ts lib/utils/expressionSlots.test.ts > "$SCRATCH/t5b.txt" 2>&1; tail -20 "$SCRATCH/t5b.txt"`
Expected: PASS.

- [ ] **Step 5: Commit**

"Lower the `?` operator to a hoisted temp and a failure guard".

---

### Task 6: Expand `?` under `with approve` inside the handler region

**Files:**
- Modify: `lib/preprocessors/hoistCalls.ts:260-266` (the `withModifier` case)
- Modify: `lib/preprocessors/hoistCalls.test.ts`, `lib/preprocessors/hoistPositions.test.ts` (unskip the program from Task 4)

**Interfaces:**
- Consumes: `containsUnwrap`; the `HandleBlock` shape in `lib/types/handleBlock.ts` with `handler: { kind: "functionRef", functionName }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("expands const x = foo()? with approve into a handle block", () => {
  const body = stmts(hoistCallsInScope(bodyOf(`def f(): Result {\n  const x = foo()? with approve\n  return success(x)\n}`))) as any[];
  expect(body[0].type).toBe("handleBlock");
  expect(body[0].handler).toEqual({ kind: "functionRef", functionName: "approve" });
  expect(stmts(body[0].body).map((n) => n.type)).toEqual(["assignment", "assignment", "ifElse", "assignment"]);
});
it("keeps every temp inside the handle block: foo(bar())? with approve", ...)   // body[0].body holds the bar() temp; nothing precedes the handle block
it("leaves a with statement with no unwrap untouched", ...)                      // `use(target()) with approve` is still a withModifier
it("preserves reject and propagate", ...)
```

Unskip "an unwrap under with" in `hoistPositions.test.ts`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test:run lib/preprocessors/hoistCalls.test.ts lib/preprocessors/hoistPositions.test.ts > "$SCRATCH/t6.txt" 2>&1; tail -30 "$SCRATCH/t6.txt"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the `withModifier` case: if `!containsUnwrap(stmt.statement)` return `[stmt]` as today. Otherwise `const inner = rewriteStatement(stmt.statement, counter)` and return one `handleBlock` with `body: inner`, `handler: { kind: "functionRef", functionName: stmt.handlerName }`, `loc: stmt.loc`. Update the case comment to say why the expansion goes inside the region.

- [ ] **Step 4: Run to see them pass**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

"Expand the `?` operator under `with approve` inside the handler region".

---

### Task 7: Codegen tripwire and generator fixture

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1267` (`processValueAccess`)
- Create: `tests/typescriptGenerator/unwrap.agency` (and the generated `unwrap.mjs`)
- Create: `lib/backends/unwrapTripwire.codegen.test.ts` (one test; `lib/backends/frameClaims.test.ts` is the model for a small codegen test)

- [ ] **Step 1: Write the failing tripwire test**

Build a `ValueAccess` with an unwrap element by hand and call the builder on a program that contains it without running the preprocessor; expect it to throw an error whose message contains `unwrap` and `toolchain bug`.

- [ ] **Step 2: Implement**

In `processValueAccess`, the chain switch gets `case "unwrap": throw new Error("An unwrap (?) reached codegen; the hoist pass should have lowered it. This is a toolchain bug.")`. Put the message in one exported constant and throw it from both `processValueAccess` and the `assignmentEmitter.ts` switch Task 2 touched.

- [ ] **Step 3: Add the fixture**

`tests/typescriptGenerator/unwrap.agency`:

```
def parseName(text: string): Result<string> {
  if (text == "") {
    return failure("empty")
  }
  return success(text)
}

def greet(text: string): Result<string> {
  const name = parseName(text)?
  const upper = parseName(name)?.toUpperCase()
  return success("hello ${upper}")
}

node main() {
  return greet("x") catch "none"
}
```

Run `make fixtures`, open `tests/typescriptGenerator/unwrap.mjs`, and confirm by eye that `greet` contains two `isFailure` temps, two `runner.ifElse` guards that halt with the temp, and no `?` anywhere.

- [ ] **Step 4: Run the generator integration test and the builder test**

Run: `pnpm test:run lib/backends/typescriptGenerator.integration.test.ts lib/backends/unwrapTripwire.codegen.test.ts > "$SCRATCH/t7.txt" 2>&1; tail -20 "$SCRATCH/t7.txt"`
Expected: PASS.

- [ ] **Step 5: Commit**

"Codegen refuses an unlowered unwrap; add the generator fixture".

---

### Task 8: Execution tests for interrupts, handlers, loops, and blocks

**Files:**
- Create: `tests/agency/unwrap/basics.agency` + `basics.test.json`
- Create: `tests/agency/unwrap/handlers.agency` + `handlers.test.json`
- Create: `tests/agency/unwrap/control-flow.agency` + `control-flow.test.json`

The `.test.json` format is the one in `tests/agency/casts/castValidatorHandled.test.json`: `nodeName`, `input`, `expectedOutput` (a JSON string), `evaluationCriteria: [{ "type": "exact" }]`. No LLM calls anywhere in these files.

- [ ] **Step 1: Write `basics.agency`**

Nodes, each returning a string so `expectedOutput` is a quoted string:

- `successValue`: `parseName("bob")?` then return the value → `"bob"`.
- `failureReturned`: a def `wrap(text: string): Result<string> { const name = parseName(text)?; return success("never") }` called with `""`; the node matches on the result and returns `"failed: empty"`.
- `failureKeepsData`: `parseName` fails with data `{ code: 7 }`; the node returns the `.data.code` of the returned failure → `"7"`.
- `chain`: with `def half(n: number): Result<number>` (fails on an odd argument with message `"odd"`) and `def box(n: number): Result<{ n: number }>`, a def computes `half(box(4)?.n)?` → `"2"`.
- `blockReturn`: `map([1, 2]) as n { return half(n)? }` with `half(1)` failing; the node reports whether item 0 is a failure and item 1 is a success → `"failure,success"`.
- `returnPosition`: `def direct(text: string): Result<string> { return success(parseName(text)?) }` → `"bob"`.

- [ ] **Step 2: Write `handlers.agency`**

Copy the shape of `tests/agency/casts/castValidatorHandled.agency`: `effect test::check { n: number }`, a def `ask(n: number): Result<number>` that raises `test::check` and returns `success(n)`, and a def `use(n: number): Result<string> { const v = ask(n)?; return success("got ${v}") }`.

- `approved`: `handle { return use(6) } with approve` → `"got 6"`.
- `rejected`: `handle { return use(6) } with reject`; `use` bumps a module-level `let afterUnwrap = 0` on the line after its `?`. The node matches the returned failure and returns `"rejected,${afterUnwrap}"` → `"rejected,0"`.
- `decidedByData`: handler rejects when `intr.data.n == 6` → `"rejected"`.
- `withApproveOneLine`: `const v = ask(6)? with approve` → `"6"`.
- `withRejectOneLine`: inside a def, `const v = ask(6)? with reject` then `return success("after")`; the node reports the def returned a failure → `"rejected"`.
- `ranOnce`: a module-level `let asks = 0` bumped inside `ask`; after `handle { use(6) } with approve` return `"${asks}"` → `"1"`.

- [ ] **Step 3: Write `control-flow.agency`**

- `whileCondition`: inside a def returning `Result<number>`, `let i = start` then `while (half(i)? < 3) { i += 1 }`; `half` fails on an odd argument with `"odd"`, so a start of `0` fails on the second pass. The node returns the def's failure message → `"odd"`.
- `ifCondition`: `if (parseName(text)? == "bob") { ... }` → `"yes"`.
- `forIterable`: `for (item in items(text)?) { ... }` → the joined items.
- `argumentPosition`: `use(half(4)?)` where `use(n: number): string` → `"2"`.
- `nestedHandle`: a `?` inside a `handle` block inside a `for` loop, approved → the count of iterations that completed.
- `blockInsideParallel`: a `parallel` block with two arms on separate lines, `const a = map([2]) as n { return half(n)? }` and `const b = half(4)` (Agency separates statements with newlines, never semicolons); the node reports `a[0]` is a success with value `1` → `"1"`. (A `?` at an arm's top level is a compile error, AG1024, tested in Task 4.)

- [ ] **Step 4: Build and run the three test files**

Run: `pnpm run build > "$SCRATCH/t8-build.txt" 2>&1 && for f in basics handlers control-flow; do pnpm run agency test tests/agency/unwrap/$f.test.json > "$SCRATCH/t8-$f.txt" 2>&1; tail -8 "$SCRATCH/t8-$f.txt"; done`
Expected: every node passes. If a node fails, read the saved output; do not rerun.

- [ ] **Step 5: Commit**

"Execution tests for the `?` operator: handlers, control flow, blocks".

---

### Task 9: A pause inside the operand, resumed from a serialized checkpoint

**Files:**
- Create: `tests/agency-js/unwrap-resume/agent.agency`, `counter.js`, `test.js`, `fixture.json`

Follow `tests/agency-js/restore-loop-after-resume/` for the shape: the node raises an effect with no handler, the test gets the interrupts back, serializes the checkpoint through JSON, and calls `respondToInterrupts`.

- [ ] **Step 1: Write the agent**

```
import { bump, bumpCount } from "./counter.js"

effect test::gate { n: number }

def ask(n: number): Result<number> {
  bump()
  raise test::gate("ok?", { n: n })
  return success(n)
}

export node paused(): Result<string> {
  const v = ask(6)?
  return success("got ${v}")
}

export node pausedTwice(): Result<string> {
  const a = ask(1)?
  const b = ask(2)?
  return success("got ${a} and ${b}")
}
```

`counter.js` exports `bump`, `bumpCount`, and `reset` over a module-level number.

- [ ] **Step 2: Write `test.js`**

Four runs, all recorded into `__result.json`:

1. `paused()` → an interrupt is returned (`result.data` is the interrupt list). Record `interrupted: true`, `effect: data[0].effect`.
2. Round-trip the interrupts through `JSON.parse(JSON.stringify(...))`, then `respondToInterrupts(copy, copy.map(() => approve()))`. Record the final value (`"got 6"`) and `bumpCount()` (must be `1`: the operand ran once).
3. Reset; `paused()` again; respond with `reject("no")` (`reject` is exported from the same `./agent.js` as `approve` and `respondToInterrupts`). Record that the result is a failure, its message contains `"no"`, `rejected` is true, and `bumpCount()` is `1`.
4. Reset; a second node `pausedTwice()` that does `ask(1)?` then `ask(2)?`; approve the first, confirm a second interrupt arrives with `n: 2`, approve it, and record the final value and `bumpCount()` of `2`.

- [ ] **Step 3: Record and inspect the fixture**

Run: `pnpm run build > "$SCRATCH/t9-build.txt" 2>&1 && pnpm run agency test js tests/agency-js/unwrap-resume > "$SCRATCH/t9.txt" 2>&1; tail -20 "$SCRATCH/t9.txt"`
The runner prints the result and fails because there is no fixture yet. Check every printed value against the list above, write the result to `fixture.json`, and run the same command again. Expected: pass.

- [ ] **Step 4: Commit**

"Resume test: a pause inside an unwrap operand runs the operand once".

---

### Task 10: Documentation

**Files:**
- Create: `docs/dev/language/unwrap-operator.md`
- Modify: `CLAUDE.md` (index line under "Language semantics and syntax features", alphabetical), `.claude/skills/agency-language-docs/SKILL.md` (same line)
- Modify: `docs/dev/compiler/hoist-calls.md` (table row for the unwrap element; the `with`/`static` row now says "opaque, except a `with` statement containing `?`, which is rewritten inside a `handle` block")
- Modify: `docs/site/guide/error-handling.md` (new section after "The `catch` keyword")
- Modify: `stdlib/agents/prompts/agency-tutorial.md` (the Result section and the `with approve` example)

- [ ] **Step 1: Write the dev doc**

Mechanism and rules only, no history (the spec holds the reasoning). Sections: the grammar and the `unwrap` chain element; the lowering with the spec's `a()?.b()?` example and its output; the `with` expansion; the three position diagnostics and the two type diagnostics with their codes; why codegen throws on an unwrap; the block rule for `return`; the two rules a reader will trip on (`foo()? with approve` does not parse, because the shorthand takes only an assignment, a return, or a call; and a `?` at the top level of a `parallel` arm is refused); the refused positions named plainly, including both sides of `catch` and the stages of `|>`; a section "Interrupts, case by case" carrying the spec's list (a pause inside the operand, a rejection, handlers, checkpoint and restore, forks, handler bodies, fingerprints), because the owner reviews every PR on those questions; the files list from the spec.

- [ ] **Step 2: Add the index lines**

One line in each index, in the style of the neighbors: `docs/dev/language/unwrap-operator.md` — The `?` operator: an access-chain element that unwraps a `Result` or returns its failure, lowered by the hoist pass to a temp and an `isFailure` guard, the `with approve` expansion, and the seven diagnostics that refuse it where it cannot return or be lowered.

- [ ] **Step 3: Update the guide**

In `docs/site/guide/error-handling.md`, a section "The `?` operator" with the four-line before and one-line after from the spec's summary, the chain example, the rule that the enclosing function must return a `Result`, and one sentence that `?` is for passing a failure through unchanged while `failure("context: ${err}")` after a `match` is still how to add a message.

- [ ] **Step 4: Update the tutorial**

Read `docs/dev/agents/agency-writer-prompt.md` "Rules for editing the tutorial" first. In the Result section, after `catch`, add the operator with one example. Change the `with approve` example at line 546 to show `?` as the second form: keep `catch ""` where the sample wants a string fallback, and add `const content = read("file.txt")? with approve` in a def declared to return a `Result`. Extract every fenced block and run `pnpm run ast` on each; all must parse except the ones the rules say may not.

- [ ] **Step 5: Check prose**

Read the new and changed prose against `~/.claude/skills/simplify-speech/verbal-tics.md` and fix what it flags.

- [ ] **Step 6: Commit**

"Document the `?` operator".

---

### Task 11: Repo-wide checks and the pull request

- [ ] **Step 1: Typecheck, lint, format, unit tests**

Run: `pnpm run typecheck > "$SCRATCH/t11-tc.txt" 2>&1; pnpm run lint:structure > "$SCRATCH/t11-lint.txt" 2>&1; pnpm run fmt:ts; pnpm test:run > "$SCRATCH/t11-unit.txt" 2>&1; tail -15 "$SCRATCH/t11-unit.txt"`
Expected: no errors in the first two files; the unit suite passes. Read the saved files; do not rerun on a failure without reading first.

- [ ] **Step 2: Anti-pattern audit**

Read the branch diff (`git diff main...HEAD`) against `docs/dev/contributing/anti-patterns.md` and fix anything it names.

- [ ] **Step 3: Push and open the PR**

Write the PR description to a file: what the operator is, the lowering in two sentences, the breaking removal of optional chaining and why it is safe, the seven diagnostics, and the test files. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. `git push -u origin adit/question-mark-operator` then `gh pr create --title "Add the ? operator: unwrap a Result or return its failure" --body-file <file>`. Do not merge; the owner merges.

- [ ] **Step 4: Watch CI**

The `tests/agency` suite runs in CI. Check each job on the PR's head commit; fix and push for any failure.

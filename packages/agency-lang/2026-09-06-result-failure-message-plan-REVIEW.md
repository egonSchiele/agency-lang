# Review: result failure messages plan

Reviewed 2026-09-06 against `2026-09-06-result-failure-message-plan.md` and the
spec. Every file and line the plan names was checked against the code on
`main` at `3c92c0514`. The design is at the right altitude: it reuses the
Result union, the covariant assignability check, and the diagnostics
registry instead of adding a layer. The problems below are execution
problems, and two of them will stop the plan partway through.

## Verdict

Not ready to execute as written. Fix the four blocking items first. The
rest are small and can be folded in while executing.

## Blocking

### 1. The fixture rewrites use the wrong path: `.error.data.x` instead of `.data.x`

The new failure shape puts `data` beside `error`, not inside it:

```ts
{ success: false, error: "Guard 'research' exceeded...", data: { maxCost: 0.3, ... } }
```

So `result.error.maxCost` has to become `result.data.maxCost`. The plan
writes `result.error.data.maxCost` in every mechanical rewrite:

- Task 2 step 6: `result.error.data.maxCost` in the guards fixtures.
- Task 3 step 6: `error.data.<field>` in the subprocess fixtures.
- Task 6 step 3: `loaded.error.data.status` in `policy.agency`.
- Task 6 step 5: `p2.error.data.status` in the agency-js policy fixture.
- Task 12 step 2: `error.data.label` and `result.error.data.label` in the
  guards guide.

The plan's own new tests get it right (`looked.data.id` in Task 1 step 9,
`result.data.label` in Task 2 step 7), so this is a slip, not a design
choice. At runtime `"a string".data` is undefined, so every one of the
rewritten fixtures would print `null` and fail at Task 2 step 8.

The spec has the same slip in its Migration section ("`result.error.maxCost`
to `result.error.data.maxCost`"). Fix both.

### 2. The task order breaks the build between Task 2 and Task 8

The plan says each task leaves the build green, and gives the reason for
running runtime changes before compiler changes. The reverse dependency is
missed. Until Task 8, the type checker does not know a `data` field exists
and still types `failure(msg, obj)` from its first argument.

Two consequences:

- **Tasks 2 and 3.** A fixture that reads `result.data.maxCost` after an
  `isFailure` check is narrowed to the failure member of the Result union
  (`resultUnion.ts:29`), which has no `data` property. Strict member access
  defaults to `error` (`synthesizer.ts:167`), so that is a
  `propertyDoesNotExist` diagnostic, and the guard and subprocess suites
  fail to compile at Task 2 step 8 and Task 3 step 7.
- **Task 6.** `parsePolicyFile` is declared `Result<Policy, ParsePolicyFailure>`.
  The old synthesizer types `failure("...", { status })` as `Result<any, string>`
  from the first argument (`synthesizer.ts:801`). `string` is not assignable
  to the `ParsePolicyFailure` object type, so `make` fails on the stdlib at
  Task 6 step 6. Same for `outcomeToResult` in `coding.agency`.

The clean fix is to move Tasks 7, 8, and 9 ahead of Task 2, and to land the
fixture rewrites in the same commit as Task 8 (the checker only refuses
`.error.maxCost` once `.error` is a string, which is also Task 8). Tasks 1,
4, and 5 are TypeScript-only and can stay where they are. Rewrite the
"order this plan runs in" paragraph to match.

### 3. Validated returns still name `string` as the data type

`resultTypeForValidation` at `lib/typeChecker/validation.ts:19` wraps a
validated return (`def f(): number!`) as `Result<T, string>`:

```ts
return { type: "resultType", successType: t, failureType: STRING_T };
```

Task 7 lists `validation.ts` under the mechanical rename only. After the
rename that line says the data type is `string`, which is exactly the
annotation Task 10 removes everywhere else. Two things go wrong:

- Every validated function's return type prints as `Result<T, string>`,
  since the printers now only elide `any`.
- A function declared `Result<T, D>` that returns the result of a validated
  call fails assignability, because `string` is not assignable to `D`.

Change the constant to `ANY_T` in Task 7, and add a one-line test in
`validation.test.ts` (or wherever `resultTypeForValidation` is covered) that
the wrapped type's `dataType` is `any`.

### 4. Task 10 claims a check the plan never adds

Task 10 says the six `Result<X, string>` annotations are "refused by the new
AG2014". AG2014 checks the second **argument to `failure()`**, not the second
**type parameter of an annotation**. Nothing in the plan refuses
`Result<number, string>` as a type. The spec says the checker rejects it; the
plan does not implement that.

Pick one and say so:

- Add the check. `isDataShaped` from Task 9 is the right predicate. The
  natural place is wherever type annotations are validated (the
  `visitTypes` walker in `typeWalker.ts` is how other annotation checks
  run). Register a fourth diagnostic for it.
- Or drop the claim, and describe Task 10 as cleanup of annotations that no
  longer mean what they say.

The first option is better, because without it `Result<T, string>` stays
legal and means "string data", which no `failure()` call can produce.

## Should fix before executing

### 5. Task 5's replacement test cannot fail for the right reason

The test asserts that `failure(x).error` equals `x` and that
`_internal.toolErrorMessage` is undefined. The first is Task 1's test again.
The second is a property lookup that TypeScript already refuses once the
function is gone. Neither says anything about the tool loop.

Spec verification item 9 wants an agent test that a rejected tool call
reaches the model as a sentence. The plan drops that item without saying
so. Either add it (an agency-js fixture with a guard-tripping tool, and an
assertion on the tool-result message in the statelog, since the mock
provider cannot inspect messages), or delete the `describe("toolErrorMessage")`
block outright and note that item 9 is covered by Task 2's sentence test
plus the deletion. Do not keep a test whose only job is to pass.

Also, the import path in that test is wrong: `prompt.test.ts` lives in
`lib/runtime/`, so `failure` comes from `./result.js`, not
`../runtime/result.js`.

### 6. The guard sentence test has no deterministic expected string

Task 2 step 7's fixture trips a cost guard and asserts on the sentence. Two
issues:

- The only evaluation criterion any `.test.json` uses is `exact` (1665
  files, no `contains`). The step already hedges about this; make it
  definite.
- The sentence includes the spent amount. With the deterministic test
  provider, `actualCost` is a synthetic cost (`guard-cost-trip.test.json`
  says so), so it is deterministic, but the plan has to state the value and
  copy the `useTestLLMProvider` / `llmMocks` / `interruptHandlers` block from
  `guard-in-def.test.json`, which it does not mention. Without those, the
  fixture calls a real LLM.

### 7. The guard message wording diverges from the spec silently

Spec: `Cost guard 'research' exceeded: spent $0.42 of a $0.30 budget` and
`Time guard 'research' exceeded: ran 71s of a 60s budget`.
Plan: `Guard 'research' exceeded its cost budget: spent 0.42 of 0.3.` and
milliseconds for time.

Either wording is fine. The plan should say it changed the spec's wording
and why (dollar signs and seconds mean formatting the numbers, which the
plan avoids). Otherwise the executor will not know which one is current.

### 8. `emitAssignabilityError`'s new branch needs alias resolution

Task 9 step 5 tests `expected.type === "resultType"`. A function declared
with an alias, `type Outcome = Result<number, D>` then `def f(): Outcome`,
reaches this site with `expected.type === "typeAliasVariable"` and falls
through to the generic message. Resolve `expected` through `safeResolveType`
(already imported in `utils.ts:6`) before the check.

Also confirm `builtinGenerics.ts` does not import from `utils.ts` before
exporting `isNullType` from it for `utils.ts` to import. Today it does not
(`builtinGenerics.ts:1-5`), so this is fine, but the plan should say it
checked.

### 9. PR 2's parser step contradicts itself

Task 14 step 4 shows a code block that returns `fail(...)` for
`success(a, b)`, then a paragraph saying to use `parseError` and make the
test expect a throw, and step 1's test expects a throw. The code block is
the thing the executor copies. Make the code block use `parseError` and
delete the paragraph.

## Minor

- **Counts.** Task 1 step 3 says "twelve of the fourteen call sites carry no
  user data"; step 5 is titled "the remaining eleven". Fourteen minus the
  three `__tryCall` sites is eleven. Task 2 says twenty-one guard fixtures and
  Task 3 says twenty-four subprocess fixtures; the plan's own greps return 46
  files and 17 files. Nothing depends on the numbers, so drop them.
- **`prompt.ts:1283` comment.** The plan keeps `stringifyToolResult` at line
  1289 for a "structured reject value". After Task 5, `reject` takes a
  string, so that comment is false. Either narrow that branch to
  `String(toolResult.value)` or rewrite the comment.
- **Zod schema and `D | null`.** Task 11 generates `data: <schema of D>`.
  For `Result<T, D | null>` that is `z.union([D, z.null()])`, but the
  runtime value is `{}`, which matches neither when `D` has required fields.
  This only bites when a `Result<T, D | null>` is itself validated (a `!`
  return or structured output), which is rare. Worth one sentence in the
  dev doc and a `z.union([D, z.object({})])` or `.partial()` decision.
- **`ParsePolicyFailure` still exported with `error?`.** Task 6 step 2 drops
  the field. Check nothing else reads `.error.error` (the only reader is the
  block Task 6 step 3 rewrites, so this is fine; say so in the step).
- **Task 12 guards guide line 20.** `printJSON(error)` now prints a string.
  The plan offers two replacements and tells the executor to choose. Pick
  `print(error)`; the label example below it already shows `.data`.
- **`resultValueSchema` at `result.ts:46`** has `error: z.any()`. It is a
  shape sniff used by `__tryCall` and `__catchResult`, and `z.object` is
  non-strict, so it keeps working. Worth a line in Task 1 so the executor
  does not stop to wonder about it.

## Verified and correct

The following claims were checked against the code and hold:

- `failure(error, opts)` at `result.ts:113`; exactly fourteen call sites
  pass options positionally: `prompt.ts:1179`, `typescriptBuilder.ts:3132`,
  `result.ts:281` plus the two guard-trip sites, `functionCatchFailure.mustache:37`,
  and four each in `interruptReturn.mustache` and `interruptAssignment.mustache`.
- The builder injects options positionally at `typescriptBuilder.ts:2617`
  with a spread, so the arity padding is needed exactly as described.
- `imports.mustache:32` is where `failure` enters generated code.
- `RESULT_CONSTRUCTORS` and `RESULT_FIELDS` at `synthesizer.ts:106-119`;
  the constructor branch at `:795-802`.
- Result assignability is covariant in both parameters at
  `assignability.ts:669-683`.
- `emitAssignabilityError` at `utils.ts:183` is the single construction
  site for the generic message (two callers, `utils.ts:170` and
  `matchExprTypes.ts:152`).
- `isNullType` is private at `builtinGenerics.ts:49`.
- `mergeResultParam` at `inference.ts:135` unions the arms unless one is
  `any`, so the "`D | null` is inferred" claim holds.
- Highest `AG2` code is `AG2012`, so `AG2013`-`AG2015` are free.
- `resultPatternParser` at `parsers.ts:7480`, the committed-form
  `parseError` at `:7507`, `ResultPattern` at `pattern.ts:60`, the lowering
  case at `patternLowering.ts:1176`, and the formatter case at
  `agencyGenerator.ts:1015` all match the plan's descriptions.
- `resultTypeParser` is covered by `lib/parsers/typeHints.test.ts`.
- Every test file, template, doc page, and stdlib line the plan names
  exists at the stated location. `truncate(val, maxLen = 200)` exists.
- Every TypeScript `reject(` caller passes a string (`runPolicyHandler.ts:32`,
  `interruptResolution.ts:85`); the rest are Promise rejects.
- Member access through `D | null` is handled: the pattern-through-nullable
  test at `strictMemberAccess.test.ts:382` shows the checker narrows rather
  than refuses, so the spec's "trap" note is accurate but not a blocker.

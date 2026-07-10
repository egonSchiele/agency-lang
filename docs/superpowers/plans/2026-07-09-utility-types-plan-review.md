# Review: Built-in Utility Types Implementation Plan

**Plan:** `docs/superpowers/plans/2026-07-09-utility-types.md`
**Spec:** `docs/superpowers/specs/2026-07-09-utility-types-design.md`
**Date:** 2026-07-09
**Verdict:** Approve with fixes. One practical blocker (worktree setup), one testing gap (error surfacing is claimed but never pinned end-to-end), and minor cleanups. The architecture is at the right altitude: it sits beside the existing `Array`/`Schema`/`Record` branches and adds no new pipeline concepts.

I verified the plan's claims against the code directly. Section 3 lists what checked out, so the executor does not need to re-verify those.

---

## 1. Blocker: the worktree has no `node_modules` and no `dist`

Global Constraints says to create a fresh worktree (`git worktree add .claude/worktrees/utility-types -b utility-types`) and work there. Task 1 Step 2 then immediately runs `pnpm test:run` inside it. A fresh worktree is a fresh checkout: no `node_modules`, no `dist`. The first test run fails on missing vitest, not on the intended "cannot find module ./utilityTypes.js".

**Fix:** add a setup step after creating the worktree:

```bash
cd .claude/worktrees/utility-types && pnpm install
cd packages/agency-lang && make   # populates dist/ for the later CLI steps
```

Then Step 2's expected failure message is accurate.

## 2. Main gap: semantic argument errors are invisible at typecheck time, and no test pins this

The plan handles arity errors well (they become located diagnostics via `BUILTIN_GENERIC_ARITY`, and Task 2 tests this). But the *semantic* errors — non-object argument to `Partial`, bad `Pick` key, non-literal `K` — only exist as `TypeError` throws inside the resolver. I traced what actually happens to them:

- In the typecheck pipeline, `safeResolveType` (`lib/typeChecker/assignability.ts:43-53`) catches the `TypeError` and returns `any`. **No diagnostic is emitted.** The comment on `safeResolveType` assumes `validateTypeReferences` reports the user-facing error; that is true for arity but false for these semantic errors, which `validateTypeReferences` knows nothing about.
- The user first sees the error at codegen, when `zodSchemaFor` → `resolveTypeDeep` (`typescriptBuilder.ts:780`, `:820`) re-runs the resolver outside the safe wrapper. That surfaces as a bare, unlocated `TypeError` crash. If the type never reaches codegen, the error never surfaces at all and the annotation silently behaves as `any`.

The spec acknowledges this ("same surfacing as Record key errors", located diagnostics deferred as follow-up), and the precedent is real. Record behaves the same today. So I am not asking the plan to fix the surfacing. I am asking for two cheap additions:

1. **A test that pins the current behavior.** Task 2's pipeline tests never feed a semantic error through `typecheckSource`. Add one:

   ```ts
   it("semantic argument errors do NOT surface as typecheck diagnostics (known gap, see spec follow-up)", () => {
     const errors = typecheckSource(`
   type User = { name: string }
   node main() {
     const c: Pick<User, "nope"> = { }
     return 1
   }
   `);
     expect(errors).toEqual([]); // swallowed by safeResolveType; surfaces at codegen
   });
   ```

   Without this, the module docstring's claim ("surfaced the same way Record key errors are today") is documentation, not verified behavior. If the claim turns out wrong during execution, better to learn it from a test than from a confused user.

2. **One sentence in the Task 6 guide section** telling users where these errors appear: "A bad `Pick` key or a non-object argument is reported when the program compiles, not as an editor/typecheck diagnostic." Right now the docs list the error rules but not when the user sees them.

**Why the follow-up (located diagnostics in `validateTypeReferences`) is correctly deferred:** `validateTypeReferences` does receive the alias table, so eagerly evaluating there looks cheap. But it validates generic alias *bodies* with type params stubbed as self-referential aliases (`index.ts:150-158`). A body like `type PartialOf<T> = Partial<T>` would resolve `T` to a nominal stub, fail `resolveObjectArg`, and produce a false positive. Doing this right needs a "only when args are concrete" rule. Deferring is the correct call; the plan could carry this one-line rationale so the next person does not "improve" it naively.

## 3. Verified claims (executor: no need to re-check these)

Everything below I confirmed against the working tree today.

- **Arity message format matches the plan's test regex.** `validate.ts` emits `` `${t.name} expects ${n} type argument${...}, got ${...} (referenced in '${context}').` `` The regex `/Partial expects 1 type argument, got 2/` matches.
- **`type Bad = Partial<User, User>` yields a diagnostic even though `Bad` is unused** — `validateTypeReferences` runs over every alias body (`index.ts:171`).
- **Reserved-name message matches.** `index.ts:216`: `'Partial' is a reserved built-in type; cannot be redefined.`
- **Insertion point is right.** The `Record` branch ends at `assignability.ts:137`; the user-defined lookup (which throws `Unknown generic type`) follows at `:139`. The plan's warning about ordering is accurate.
- **All named imports exist:** `NULL_T`/`NEVER_T` (`primitives.ts:8,10`), `formatTypeHint` (`lib/utils/formatType.ts:26`), `typecheckSource` (`lib/typeChecker/testUtils.ts:20`), `stringLiteralType` is the correct node name (`typeHints.ts:146`), `GenericType` has an optional `tags` field (`typeHints.ts:50`) so `attachAliasTags(evaluated, vt.tags)` typechecks.
- **Codegen route is as claimed.** `deepResolveNode` sends every `genericType` through `resolveType` (`assignability.ts:293`), and both alias declarations (`typescriptBuilder.ts:780`) and `schema(...)` expressions (`processSchemaExpression`, `:1221-1223`) go through `zodSchemaFor` → `resolveTypeDeep`. The new branch is reached from both.
- **The Task 5 `Partial` accept case should work on the primary path.** `schema(...)` lowers via `mapTypeToValidationSchema`, which is hard-wired to `optional-coalesce` mode (`typeToZodSchema.ts:284`): nullable props get `.optional().default(null)`, so `parseJSON("{}")` succeeds with keys null-coalesced. The plan's fallback instruction (switch input to explicit nulls) most likely never fires, which is fine.
- **`never` reaches zod safely:** `z.never()` (`typeToZodSchema.ts:117-122`), so `Required` of an exactly-null property will not crash codegen.
- **`schema(Partial<User>)` parses.** `schemaExpressionParser` takes a full `variableTypeParser` (`parsers.ts:2534`), and `genericTypeParser` args recurse through `variableTypeParser` (`parsers.ts:1577-1582`), so unions like `NonNullable<string | null>` parse inside generic args.
- **`isSuccess`/`isFailure` are builtins** (`resolveCall.ts:48-49`) and the `.test.json` serialization format (`JSON.stringify`, strings quoted) matches existing files exactly.
- **Task 3's target exists with the exact style assumed:** `agencyGenerator.test.ts:6` has the "Function Parameter Type Hints" describe block, with cases shaped `def add(x: number) {\nx\n}`.
- **No existing `.agency` file (stdlib or tests) defines a type named `Partial`, `Required`, `Pick`, `Omit`, or `NonNullable`**, so Task 2 Step 6's feared reserved-name regression almost certainly will not fire. Keep the check anyway; it is free.
- **`docs/site/guide/types.md` exists and is hand-written** (relative to `packages/agency-lang/`), and guide pages use ` ```ts ` fences, matching Task 6.

## 4. Suggested test additions (cheap, high value)

- **Composition:** `Partial<Pick<User, "name">>`. The inner `Pick` resolves through the injected `resolve` callback when `resolveObjectArg` runs. This works by construction, but nothing in the plan exercises nested utility applications, and this is the first thing users will try.
- **User generic alias delegating to a utility:** `type PartialOf<T> = Partial<T>` used as `PartialOf<User>`. I traced the resolution: the user-defined-generic branch substitutes `T := User` first, then re-resolves the body, hitting the new branch with a concrete argument. It should work, and it is a natural user pattern worth one pipeline test. (Note the declaration itself typechecks clean because arity validation passes on the stubbed body; only the use site exercises the transform.)
- **`Omit` of every key** → empty object type → `z.object({})`. Degenerate but legal; one unit-test line.

## 5. Minor points

- **Task 2 Step 1 appends an `import` statement after existing code.** Imports are hoisted so it runs, but put it at the top of the file with the other imports.
- **Spec/plan API drift is fine but should be marked intentional.** The spec says `evalUtilityType(name, typeArgs, aliases, resolve)`; the plan drops `aliases` (the resolver closure carries them). The plan's version is better. Add a one-line note so an executor diffing plan against spec does not "restore" the fourth parameter.
- **`attachAliasTags(evaluated, vt.tags)` in the new branch is an inconsistency with siblings.** The `Array`/`Schema`/`Record` branches do not attach use-site tags. Attaching them is harmless (no-op when `tags` is undefined) and arguably more correct, but say so in the branch comment ("siblings drop use-site tags; we keep them deliberately") or drop it for symmetry. Silent divergence between adjacent branches is where future confusion lives.
- **Task 6's appended markdown embeds a ` ```ts ` fence inside the plan's own ` ```markdown ` fence.** The plan file's rendering breaks there. Harmless for execution (the executor copies raw text), but worth knowing when reading the rendered plan.
- **The guide example body uses `...` as a placeholder** inside a `def`. That is established convention on other guide pages, so fine; just do not let it leak into any runnable test file.

## 6. Anti-pattern audit (against `docs/dev/anti-patterns.md`)

The headline question: does the plan expose declarative interfaces that encapsulate the imperative "how"? **Yes, structurally this is the plan's strongest quality.** All five transforms live in one pure module; the resolver branch is a six-line delegation; `UTILITY_TYPE_ARITY` is a data table that `validate.ts` and `index.ts` consume by spreading, so the "what" (which names, which arities) has a single source of truth. Downstream passes never learn these types exist, which is the strongest form of encapsulation available: adding or changing a transform touches one file. The transforms themselves are `map`/`filter` expressions, not accumulator loops.

Four concrete deviations, in descending order of worth fixing:

1. **Useless special case: the `switch` default branch is dead code.** `evalUtilityType` throws `Unknown utility type ${name}` at the top when the arity lookup fails. Every name that survives that check has a `case`. The `default:` at the bottom repeats the same throw and can never execute. Delete it — or better, see point 2.

2. **The registry is only half declarative: arity lives in a table, behavior lives in a switch.** The five names appear in two parallel structures that must stay in sync by hand: the keys of `UTILITY_TYPE_ARITY` and the cases of the switch. This is exactly the "what/how split" the anti-pattern doc asks for, applied halfway. A single table finishes the job:

   ```ts
   const UTILITY_TYPES: Record<string, {
     arity: number;
     apply: (typeArgs: VariableType[], resolve: Resolve) => VariableType;
   }> = {
     Partial: { arity: 1, apply: (args, resolve) => { ... } },
     ...
   };
   export const UTILITY_TYPE_ARITY = /* derived by mapping UTILITY_TYPES */;
   ```

   `evalUtilityType` shrinks to a lookup + arity check + `entry.apply(...)`, the dead default disappears by construction, and adding a sixth utility type means adding one table entry. Recommended, not required — the switch is acceptable, but the plan is one step away from fully declarative.

3. **`resolveKeysArg` is an imperative accumulator loop** (`const keys: string[] = []` + `for` + `push`) in a module that is otherwise `map`/`filter`. `return members.map((m) => { ...throw...; return rm.value; })` says the same thing declaratively. While there, rename `rm` — the doc bans opaque short names, and `rm` is the one identifier in the module that earns the ban (`t`, `p`, `m` in one-line lambdas match the surrounding codebase's convention, e.g. `assignability.ts:133`, and are fine).

4. **Near-duplication of `stripNullable`, justified in the spec but not in the code.** `synthesizer.ts:497` has a private `stripNullable` that is shape-identical to the plan's `stripNull`, with two contract differences: it returns `undefined` instead of `NEVER_T` for the empty case, and it strips `undefined` as well as `null`. The spec explains why a separate copy is right (the type-level version needs `never`; the synthesizer version serves narrowing). The plan's code comment does not carry that reasoning. Add one line above `stripNull` naming `stripNullable` and the contract difference, so a future cleanup does not "deduplicate" them into a bug.

Checked and clean: no order-dependent mutable state (everything is `const`, each value derived from inputs); no leaky abstraction (the resolver is injected, the output is ordinary types); no nested ternaries (the one ternary in `Partial`'s map is flat); no silent catch blocks; no nested type definitions; no dynamic imports; no magic numbers; no conditional-spread pattern. One tension to be aware of: the plan uses brace-less guard returns (`if (isNullType(t)) return NEVER_T;`), which the anti-pattern doc's "one-line if" entry technically bans, but which is the dominant convention in the exact code being extended (`assignability.ts:62,70,188` and `stripNullable` itself). Follow the neighbors; add braces only if the structural linter objects.

## 7. Test-plan review: do the tests fail when the code breaks?

Method: for each test, I asked what plausible implementation bug would still pass it (mutation analysis), using the plan's own Task 1 implementation as the reference.

### What holds up well

The suite's overall design is genuinely mutation-sensitive. The strongest structural choices:

- **The accept/reject pairing in every Task 5 execution test covers both failure directions.** The accept node catches an over-strict schema, the reject node catches an over-lenient one. I traced each pair against the "transform does nothing" mutation and every one fails as it should. Examples: if `Required` were identity, `age` stays nullable, optional-coalesce forgives the missing key, the parse *succeeds*, and the reject node returns `"accepted"` — test fails. If `Pick` were identity, the stripped `email` key survives into the output and the accept node's exact-match fails. If `NonNullable` were identity, `parseJSON("null")` succeeds and the reject node fails. The reject nodes alone would false-pass when the schema rejects everything, but the paired accept node catches exactly that, so the pairing is load-bearing — keep it.
- **Task 2's "rejects a wrongly-typed property under Partial" is the anti-`any` sentinel.** If the new branch throws and `safeResolveType` silently degrades `Partial<User>` to `any`, the happy-path test still passes but this one fails (no assignability error gets produced against `any`). This is the single most important pipeline test; do not weaken it.
- **The Pick pipeline test catches the complement bug.** `Pick<User, "name">` implemented as Omit produces `{age}`, the literal `{name: "x"}` fails assignability, errors appear. Verified against the checker's missing-property behavior.
- **Task 4's fixture is a real regression net, not a smoke test.** The checked-in `.mjs` is a golden file; any change to how `Partial` lowers to zod shows up as a fixture diff in CI.
- **The red-run expectations are honest.** Task 1 red fails on the missing module; Task 2 red fails with `Unknown generic type 'Partial'` (verified that is the pre-change diagnostic); the reserved-name test is red before Task 2 Step 4 because the name is not yet reserved. Task 3 is a pin test and the plan says so.

### Mutations that survive the entire suite (add tests for these)

These are concrete bugs an executor or future refactorer could introduce; every test in the plan would stay green.

1. **In-place mutation of the shared alias body.** `resolveTypeWithGuard` returns the alias table's *own stored body object* for a plain alias (`assignability.ts:91` → the `return vt` fallthrough, and `attachAliasTags` is a no-op without tags). So `evalUtilityType` operates on shared state: a rewrite that mutates (`p.value = addNull(p.value)` instead of spreading) would corrupt `User` in the alias table for the remainder of the compile — every later use of `User` becomes partial. All current tests still pass: the unit tests compare output (which equals the mutated input), and each pipeline test uses the alias once. **Add:** in the unit tests, deep-clone the input, run the transform, and assert the input still equals the clone — one test each for `Partial` and `Required` (the two that rewrite property values).

2. **Dropping `resolve` from `Partial`'s nullability check.** Change `includesNull(resolve(p.value))` to `includesNull(p.value)` and every test passes: the no-double-null test uses a direct union (no alias needed), and the alias-preservation test uses an alias that resolves to non-null `string`, where both variants produce the same output. The behavior that breaks — a property whose type is an *alias to* `string | null` gets a second null bolted on — has no test. **Add:** a unit test where a property's value is `typeAliasVariable("MaybeStr")` resolving to `string | null`, asserting `Partial` leaves the property exactly as written.

3. **Dropping `resolve` from `NonNullable`.** The implementation is `stripNull(resolve(typeArgs[0]))`; delete the `resolve` call and all four NonNullable unit tests pass, because every one hands in an already-concrete type. The "argument resolution" describe block covers `Pick`, `Required`, and `Partial` but skips `NonNullable`. **Add:** `evalUtilityType("NonNullable", [aliasRef], resolve)` where the alias resolves to `string | null`, expecting `string`.

4. **`Required` silently dropping descriptions and tags.** Only `Partial` has a metadata-preservation test. `Required` rebuilds every property (`{...p, value: stripNull(...)}`); rewrite that as `{key: p.key, value: ...}` and descriptions and `@validate` tags vanish with no test failing. `Pick`/`Omit` are safe by construction (they pass through the original property objects), but `Required` is not. **Add:** one `Required` test asserting a description and a tag survive.

### Missing test cases (no mutation needed — the behavior is simply uncovered)

5. **The LLM-path zod mode (`required-nullable`) is never exercised.** The spec claims `Partial<T>` matches hand-written `p?:` in *both* `optionalKeyMode` behaviors, but every runtime test goes through `parseJSON`, which is `optional-coalesce` only. The `required-nullable` shape (LLM structured output and tool schemas via `mapTypeToZodSchema`) has zero coverage. Cheap fix, no LLM call needed: add a `def patch(changes: Partial<User>): string { ... }` to the Task 4 fixture — function tool schemas lower through the required-nullable mapper, so the golden `.mjs` pins that shape too.

6. **Semantic-error surfacing end-to-end** — covered in section 2 above; the pin test belongs in Task 2.

7. **Composition and delegation** — covered in section 4 above: `Partial<Pick<User, "name">>` (unit) and `type PartialOf<T> = Partial<T>` used as `PartialOf<User>` (pipeline).

8. **`Omit` of every key → empty object type** — one unit-test line; also confirms `z.object({})` doesn't upset codegen if added to a fixture.

9. **Bare `Partial` with no type arguments.** `const x: Partial = ...` parses as a `typeAliasVariable`, misses the genericType branch entirely, and today would produce `Type alias 'Partial' is not defined` — a confusing message for a now-reserved name. Nothing in the plan tests or documents what the user sees. At minimum pin the current diagnostic in a Task 2 test so the behavior is a decision rather than an accident.

10. **Formatter round-trip only covers parameter positions.** `type UserPatch = Partial<User>` as a type-alias declaration goes through the same `formatTypeHint` printer, so risk is low, but one alias-declaration case in Task 3 would close it.

Not worth adding: duplicate keys in `K` (`Pick<T, "a" | "a">` — filter-based implementation is trivially idempotent), `Omit` with a non-literal `K` (shares `resolveKeysArg` with the tested `Pick` path — though note the coverage argument depends on that sharing surviving refactors), and per-type arity errors (arity checking is one shared code path; the single `Partial` arity test covers it).

## 8. What the plan gets right (worth keeping as-is)

- TDD structure with red-run expectations that name the exact expected failure message per step.
- The failure-diagnosis notes ("if the narrowing test fails, the branch is probably after the user-defined lookup") are correct per my code reading, not guesses.
- Keeping the written property value in `Partial` output (resolving only to decide nullability) so alias names survive into codegen and doc output. This matches how `Record` preserves its wrapper for codegen.
- The decision to keep a local `stripNull` rather than exporting `synthesizer.ts`'s private `stripNullable` — correct module-boundary call, and the type-level copy needs `never` handling the synthesizer copy lacks.
- Task 4's fixture-churn guard (stop if `make fixtures` touches unrelated files).

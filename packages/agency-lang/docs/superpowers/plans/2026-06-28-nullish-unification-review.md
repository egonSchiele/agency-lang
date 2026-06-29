# Review: Nullish Unification Plan (2026-06-28)

Reviewer: Amp (Sonnet 4.5)
Plan: [`2026-06-28-nullish-unification.md`](./2026-06-28-nullish-unification.md)
Spec: [`../specs/2026-06-28-nullish-unification-design.md`](../specs/2026-06-28-nullish-unification-design.md)

## Verdict

Plan is **executable as-is** and well-structured. The cited line numbers and code snippets match real source (verified at `typescriptBuilder.ts:1064-1072`, `:1525-1534`, `parsers.ts:1049-1076`, `imports.mustache`, `ir/builders.ts:675` for `ts.not`). Recommend three pre-execution edits below.

## Real concerns

### 1. Task ordering risk between Tasks 3 and 5 (AST-shape gap)

Task 3 makes `objectPropertyParser` produce `T | null`, but Task 5 (which retargets `UNDEFINED_T`/`isOptionalType` to `null`) doesn't land until after Task 4. Between Task 3 and Task 5, the type checker still keys on `"undefined"`, so an optional key is silently *not optional* from the checker's POV.

Any `make fixtures` or typecheck run between those tasks is unreliable, and any failing intermediate assertion is hard to attribute.

**Fix:** Bundle Tasks 3, 4, 5 into a single commit, OR explicitly state in the plan: "do not regenerate fixtures or run typechecker tests until after Task 5."

### 2. Task 5 Step 9 grep is too narrow

`grep -i "UNDEFINED_T\|undef"` won't catch string-literal type references like `value: "undefined"` or `t.value === "undefined"` scattered through the type checker.

**Fix:** Add a second-pass grep before declaring no stragglers:

```bash
grep -rn '"undefined"' lib/typeChecker/ | grep -v "typeof.*undefined"
```

Same critique applies to Task 9 Step 2 — its grep excludes `errors.ts`/`asyncContext.ts` without justification and skips `stdlib/` entirely. Stdlib `.agency` files using `key?: T` or `: undefined` should round-trip clean, but worth verifying explicitly.

### 3. Task 8 nested test misses the recursion case

Spec §Testing requires:

```
parse({ a: {} })   →   { a: { b: null } }
```

The plan's `optionalKeyNested.agency` only verifies the outer-coalesce case (`parse({})`). 

**Fix:** Add a second test variant that passes `{a: {}}` and asserts `r.value.a.b == null` to confirm the recursive thread of `optionalKeyMode`.

## Smaller nits

- **Task 2 Step 4** says "modify `imports.mustache:26-27`" but line 26 is the `Schema, __validateType, ...` line; the actual edit target (`success, failure, ..., __catchResult,`) is line 25. The instruction body correctly identifies the line by content, so this is a stale line reference, not a real bug.
- **Task 7** uses a `formatAgency` helper without confirming it exists — the plan acknowledges this in fallback prose. Worth a 30-second check up front rather than discovering it at execution time.
- **Sharp-edge doc note from spec §4** (users who need `=== undefined` use `===`) isn't included anywhere in the implementation. Add to Task 9 or to `docs/dev/null-and-undefined.md`.
- **Task 9 Step 6** `git add` path `../../null-truthiness-narrowing-spec.md` assumes a specific repo layout. Plan already advises `git status` first — fine.

## What's done well

- TDD structure (failing → impl → passing) every task.
- Tasks are independently committable with focused diffs.
- Honest self-review section with one explicit user judgment call (Task 6 deferrable).
- `__eq(a, b) = a === b || (a == null && b == null)` formulation is correct, side-effect-safe (operands evaluated once via helper), and the truth-table test covers the symmetry property `__eq(x, null) === __eq(x, undefined)`.
- Defers strict-null-checking, narrowing, `null`-literal-type, and `delete` cleanly to Project 2, in alignment with the spec's Non-goals.
- Coordination notes with the flow-typed checker and `never` work (spec §6) are honored — no narrowing or `analyzeCondition` changes leak into this PR.

## Minimum recommended pre-execution edits

1. Merge Tasks 3+4+5 into a single commit (or block fixture regen + typechecker test runs until after Task 5).
2. Broaden the `"undefined"` string-literal grep in Tasks 5 Step 9 and Task 9 Step 2; include `stdlib/`.
3. Add the recursive-coalesce variant (`{a: {}}` → `{a: {b: null}}`) to Task 8.

Optional but cheap:
- Add the `===` escape-hatch doc note (spec §4) somewhere in Task 9.
- Verify `formatAgency` exists before starting Task 7.
